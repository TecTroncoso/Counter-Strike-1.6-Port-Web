#!/usr/bin/env python3
"""Optional local RCON diagnostic for the HLDS instance.

The password is never stored in this repository. Set HLDS_RCON_PASSWORD to the
same value used by the server's runtime configuration before running it.

Usage:
    HLDS_RCON_PASSWORD='your-secret' python3 scripts/rcon.py "status"
"""
import os
import socket
import sys
import time

HOST = (os.environ.get("HLDS_RCON_HOST", "127.0.0.1"), int(os.environ.get("HLDS_RCON_PORT", "27015")))


def send(sock, payload: bytes) -> None:
    sock.sendto(b"\xff\xff\xff\xff" + payload, HOST)


def recv(sock, timeout=3):
    sock.settimeout(timeout)
    try:
        data, _ = sock.recvfrom(4096)
        return data[4:]  # sin cabecera
    except socket.timeout:
        return None


def main() -> int:
    password = os.environ.get("HLDS_RCON_PASSWORD")
    if not password:
        print(
            "HLDS_RCON_PASSWORD is required (this is an optional local diagnostic)",
            file=sys.stderr,
        )
        return 2

    cmds = sys.argv[1:] or ["status"]
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        send(sock, b"challenge rcon\n")
        resp = recv(sock)
        if not resp or b"challenge" not in resp:
            print("sin challenge:", resp)
            return 1
        challenge = resp.decode(errors="replace").replace("\x00", " ").split()[2]
        for cmd in cmds:
            send(sock, f"rcon {challenge} {password} {cmd}\n".encode())
            time.sleep(0.6)
            out = recv(sock)
            print(f"> {cmd}\n{(out or b'(sin respuesta)').decode(errors='replace')[:400]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
