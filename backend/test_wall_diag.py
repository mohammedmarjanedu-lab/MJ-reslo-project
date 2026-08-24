import numpy as np
from Pynite import FEModel3D
import math

E = 5000 * math.sqrt(30) * 1e6

def run_3d(base_bc='fixed', wall_mod=1.0, wall_t=0.20):
    m = FEModel3D()
    m.add_material('M30_wall', E * wall_mod, E * wall_mod/(2*1.2), 0.2, 2500)
    m.add_material('M30_slab', E, E/(2*1.2), 0.2, 2500)

    nx, ny = 8, 8
    dx, dy = 8.0/nx, 8.0/ny
    for j in range(ny+1):
        for i in range(nx+1):
            m.add_node(f'N_{i}_{j}', i*dx, j*dy, 3.0)

    for i in range(nx+1):
        m.add_node(f'NB_{i}_0', i*dx, 0.0, 0.0)
        m.def_support(f'NB_{i}_0', True, True, True, base_bc=='fixed', base_bc=='fixed', base_bc=='fixed')
        m.add_node(f'NB_{i}_{ny}', i*dx, 8.0, 0.0)
        m.def_support(f'NB_{i}_{ny}', True, True, True, base_bc=='fixed', base_bc=='fixed', base_bc=='fixed')

    for j in range(1, ny):
        m.add_node(f'NB_0_{j}', 0.0, j*dy, 0.0)
        m.def_support(f'NB_0_{j}', True, True, True, base_bc=='fixed', base_bc=='fixed', base_bc=='fixed')
        m.add_node(f'NB_{nx}_{j}', 8.0, j*dy, 0.0)
        m.def_support(f'NB_{nx}_{j}', True, True, True, base_bc=='fixed', base_bc=='fixed', base_bc=='fixed')

    for j in range(ny):
        for i in range(nx):
            qname = f'Q_slab_{i}_{j}'
            m.add_quad(qname, f'N_{i}_{j}', f'N_{i+1}_{j}', f'N_{i+1}_{j+1}', f'N_{i}_{j+1}', 0.15, 'M30_slab')
            m.add_quad_surface_pressure(qname, 8750.0, case='LC')

    for i in range(nx):
        m.add_quad(f'W_bot_{i}', f'NB_{i}_0', f'NB_{i+1}_0', f'N_{i+1}_0', f'N_{i}_0', wall_t, 'M30_wall')
        m.add_quad(f'W_top_{i}', f'NB_{i}_{ny}', f'NB_{i+1}_{ny}', f'N_{i+1}_{ny}', f'N_{i}_{ny}', wall_t, 'M30_wall')
    for j in range(ny):
        m.add_quad(f'W_left_{j}', f'NB_0_{j}', f'NB_0_{j+1}', f'N_0_{j+1}', f'N_0_{j}', wall_t, 'M30_wall')
        m.add_quad(f'W_right_{j}', f'NB_{nx}_{j}', f'NB_{nx}_{j+1}', f'N_{nx}_{j+1}', f'N_{nx}_{j}', wall_t, 'M30_wall')

    m.add_load_combo('Combo', {'LC': 1.0})
    m.analyze(check_stability=False)
    return m.nodes[f'N_{nx//2}_{ny//2}'].DZ['Combo'] * 1000

print('1. Fixed base (uncracked t=0.20m):', round(run_3d('fixed', 1.0, 0.20), 3), 'mm')
print('2. Pinned base (uncracked t=0.20m):', round(run_3d('pinned', 1.0, 0.20), 3), 'mm')
print('3. Fixed base (cracked mod=0.35, t=0.20m):', round(run_3d('fixed', 0.35, 0.20), 3), 'mm')
print('4. Pinned base (cracked mod=0.35, t=0.20m):', round(run_3d('pinned', 0.35, 0.20), 3), 'mm')
print('5. Fixed base (cracked mod=0.35, t=0.15m):', round(run_3d('fixed', 0.35, 0.15), 3), 'mm')
print('6. Pinned base (cracked mod=0.35, t=0.15m):', round(run_3d('pinned', 0.35, 0.15), 3), 'mm')
