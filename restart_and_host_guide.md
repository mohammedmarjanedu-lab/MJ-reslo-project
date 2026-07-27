# Reslo — Calculated FEM Application Startup & Connection Guide

This guide describes how to run the Reslo Frontend and High-Performance **OpenSeesPy Backend** locally, connect them, and expose the backend to the internet for public shareability.

---

## 💻 Part 1: Running Locally (Fast & Offline)

To run the application entirely on your local machine:

### 1. Start the Python Backend
1. Open a terminal (PowerShell, Command Prompt, or terminal of your choice).
2. Run the FastAPI server (using Python 3.10 is highly recommended on this system, as Windows Smart App Control blocks the newer OpenSeesPy DLL version installed on Python 3.12):
   ```bash
   py -3.10 backend/main.py
   ```
   *The backend will start running locally at **`http://localhost:8000`**.*

### 2. Start the Frontend
1. Open a second terminal window.
2. Run the Vite/Svelte development server:
   ```bash
   npm run dev
   ```
   *The frontend will start running locally at **`http://localhost:5173`**.*

### 3. Open the App in Your Browser
Go to **`http://localhost:5173`** to access the design interface. 
*The status indicator in the bottom-left corner of the panel will automatically turn green and show **OpenSeesPy Connected**.*

---

## 🌐 Part 2: Publicly Hosting & Sharing (Secure HTTPS Tunnels)

If you want to host the app so others can access it or if you want to connect a live deployment (like Vercel or Surge) to your local backend, use the automated tunnel script:

### 1. Run the Automated Tunnel Script
Open PowerShell and run:
```powershell
powershell -ExecutionPolicy Bypass -File .\start_tunnel.ps1
```

### 2. What this script does automatically:
1. Clears ports `8000` and `5173` of any active stale processes.
2. Launches the FastAPI backend.
3. Generates a secure, public **Cloudflare HTTPS tunnel** pointing to your backend (e.g., `https://xxxx.trycloudflare.com`).
4. Updates the `.env` file with this new URL.
5. Launches the Vite frontend.
6. Generates a secure frontend tunnel.
7. Prints ready-to-use shareable links in your terminal.

---

## 🔗 Part 3: Connecting Your Backend to Live Sites

If you are using the Vercel production deployment (`https://reslo-eosin.vercel.app`) or Surge deployment (`https://reslo-graph.surge.sh`), you must provide your active backend tunnel URL. 

### Option A: Query Parameter (No Redeployment Needed)
Simply append `?api=<your-backend-url>` to the frontend URL:
* **Vercel**: `https://reslo-eosin.vercel.app/?api=https://clerk-chest-allows-powder.trycloudflare.com`
* **Surge**: `https://reslo-graph.surge.sh/?api=https://clerk-chest-allows-powder.trycloudflare.com`

*The frontend will dynamically route all OpenSeesPy solver requests to your secure local tunnel.*

### Option B: Build-time Configuration (.env)
If you want to bake the URL permanently into the build:
1. Open the `.env` file in the root folder.
2. Edit or add the line:
   ```env
   VITE_API_URL=https://your-active-tunnel.trycloudflare.com
   ```
3. Run `npm run build` and redeploy.

---

## 🛑 How to Stop Everything
To cleanly terminate all running background processes (FastAPI, Vite, and Cloudflare tunnels) and release the ports, run:
```powershell
.\stop_tunnel.ps1
```
