"""Log in as every demo account advertised by a running HADS and hit that role's main screen API.

    python scripts/smoke_logins.py --base-url http://localhost:8000
Exit code 0 only when every role works.
"""
import argparse
import sys

import httpx


def role_endpoint(me: dict) -> str:
    return {
        "requester": "/requests/mine",
        "crew": "/crew/me",
        "hospital_staff": f"/hospitals/{me.get('hospital_id')}/incoming",
        "controller": "/controller/board",
        "admin": "/admin/users",
        "authority": "/dashboard/summary",
    }[me["role"]]


def run(base_url: str) -> int:
    api = base_url.rstrip("/") + "/api"
    with httpx.Client(timeout=20) as c:
        cfg = c.get(f"{api}/public/config").raise_for_status().json()
        if not cfg["demo_mode"] or not cfg["demo_accounts"]:
            print("server is not in demo mode (no demo accounts advertised)")
            return 2
        failures = 0
        for acc in cfg["demo_accounts"]:
            try:
                r = c.post(f"{api}/auth/login", json={"identifier": acc["email"], "password": cfg["demo_password"]})
                r.raise_for_status()
                h = {"Authorization": "Bearer " + r.json()["token"]}
                me = c.get(f"{api}/auth/me", headers=h).raise_for_status().json()
                assert me["role"] == acc["role"], f"role {me['role']} != {acc['role']}"
                path = role_endpoint(me)
                c.get(api + path, headers=h).raise_for_status()
                print(f"OK    {acc['role']:<15} {acc['email']:<22} GET {path}")
            except Exception as e:  # noqa: BLE001 - report every role
                failures += 1
                print(f"FAIL  {acc['role']:<15} {acc['email']:<22} {e}")
    return 1 if failures else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base-url", default="http://localhost:8000")
    sys.exit(run(ap.parse_args().base_url))
