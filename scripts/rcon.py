#!/usr/bin/env python3
"""GoldSrc RCON mínimo: envía comandos al HLDS local (127.0.0.1:27015).

Uso: python3 rcon.py "mp_buytime 15" "sv_restart 1"
"""
import socket
import sys
import time

HOST = ("127.0.0.1", 27015)
PW = "csweb123"


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
    cmds = sys.argv[1:] or ["status"]
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send(s, b"challenge rcon\n")
    resp = recv(s)
    if not resp or b"challenge" not in resp:
        print("sin challenge:", resp)
        return 1
    challenge = resp.decode(errors="replace").replace("\x00", " ").split()[2]
    for cmd in cmds:
        send(s, f"rcon {challenge} {PW} {cmd}\n".encode())
        time.sleep(0.6)
        out = recv(s)
        print(f"> {cmd}\n{(out or b'(sin respuesta)').decode(errors='replace')[:400]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
