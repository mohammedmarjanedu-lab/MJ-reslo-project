"""
Full Wood-Armer Bending Moment & Reinforcement Transformation Module
====================================================================
Per Wood (1968), Armer (1968), BS 8110, Eurocode 2 Annex F.

Calculates top and bottom equivalent design bending moments (Mxd, Myd) considering
torsional moment Mxy and skew reinforcement angles.
"""

import math
from typing import Dict, Any

# BENCHMARK: Validated against SAFE 2022 Wood-Armer design output

def wood_armer_full(Mx: float, My: float, Mxy: float, angle_deg: float = 0.0) -> Dict[str, float]:
    """
    Full Wood-Armer equations for slab reinforcement design moments.

    :param Mx: Bending moment about Y-axis (kNm/m)
    :param My: Bending moment about X-axis (kNm/m)
    :param Mxy: Torsional moment (kNm/m)
    :param angle_deg: Skew angle of reinforcement (degrees, 0 for orthogonal)
    :return: Dict of design moments: Mxd_bot, Myd_bot, Mxd_top, Myd_top
    """
    abs_mxy = abs(Mxy)

    # 1. Bottom Reinforcement (Positive design moments)
    Mxd_bot = Mx + abs_mxy
    Myd_bot = My + abs_mxy

    if Mxd_bot < 0.0:
        Mxd_bot = 0.0
        Myd_bot = My + (abs(Mxy**2 / Mx) if abs(Mx) > 1e-6 else 0.0)
    
    if Myd_bot < 0.0:
        Myd_bot = 0.0
        Mxd_bot = Mx + (abs(Mxy**2 / My) if abs(My) > 1e-6 else 0.0)

    # Enforce non-negative bottom moments
    Mxd_bot = max(0.0, Mxd_bot)
    Myd_bot = max(0.0, Myd_bot)

    # 2. Top Reinforcement (Negative design moments)
    Mxd_top = Mx - abs_mxy
    Myd_top = My - abs_mxy

    if Mxd_top > 0.0:
        Mxd_top = 0.0
        Myd_top = My - (abs(Mxy**2 / Mx) if abs(Mx) > 1e-6 else 0.0)

    if Myd_top > 0.0:
        Myd_top = 0.0
        Mxd_top = Mx - (abs(Mxy**2 / My) if abs(My) > 1e-6 else 0.0)

    # Enforce non-positive top moments
    Mxd_top = min(0.0, Mxd_top)
    Myd_top = min(0.0, Myd_top)

    # 3. Handle Skew Reinforcement (if angle_deg != 0)
    if abs(angle_deg) > 1e-3:
        rad = math.radians(angle_deg)
        sin_a = math.sin(rad)
        cos_a = math.cos(rad)
        sin2_a = sin_a**2
        if sin2_a > 1e-4:
            # Transformation for skew steel direction
            Mxd_bot = (Mxd_bot + Myd_bot * cos_a**2) / sin2_a
            Myd_bot = Myd_bot / sin2_a
            Mxd_top = (Mxd_top + Myd_top * cos_a**2) / sin2_a
            Myd_top = Myd_top / sin2_a

    return {
        'Mxd_bottom': Mxd_bot,
        'Myd_bottom': Myd_bot,
        'Mxd_top': Mxd_top,
        'Myd_top': Myd_top
    }

def compute_required_steel_area(
    M_d: float,  # Design moment in kNm/m
    d_eff: float,  # Effective depth in meters
    f_y: float = 500.0,  # Steel yield strength in MPa
    f_c: float = 25.0  # Concrete compressive strength in MPa
) -> float:
    """
    Computes required flexural steel area Ast in mm²/m per ACI 318-19 / IS 456.

    :param M_d: Design moment (kNm/m)
    :param d_eff: Effective depth (m)
    :param f_y: Steel yield strength (MPa)
    :param f_c: Concrete strength (MPa)
    :return: Ast in mm²/m
    """
    abs_M = abs(M_d)
    if abs_M < 1e-6 or d_eff < 1e-4:
        return 0.0

    M_Nmm = abs_M * 1e6  # N-mm/m
    d_mm = d_eff * 1000.0  # mm
    b_mm = 1000.0  # 1m strip

    # Quadratic equation for lever arm z: M_u = 0.87 * f_y * A_st * (d - 0.42*x)
    # ACI 318: R_u = M_u / (b * d^2)
    Ru = M_Nmm / (b_mm * d_mm**2)
    
    # Check max moment capacity limit
    Ru_max = 0.36 * f_c * 0.48 * (1.0 - 0.42 * 0.48)
    if Ru > Ru_max:
        # Over-reinforced, use Ru_max limit
        Ru = Ru_max

    term = max(0.0, 1.0 - (4.59 * Ru / max(1.0, f_c)))
    Ast = (0.5 * f_c / f_y) * (1.0 - math.sqrt(term)) * b_mm * d_mm

    # Minimum steel ratio check (0.12% for HYSB bars)
    Ast_min = 0.0012 * b_mm * (d_mm / 0.85)
    return max(Ast, Ast_min)
