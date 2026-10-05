"""Finite sacrificial stdout only payload. No files, sockets or producer imports."""
import json
import os
import time


def emit(value):
    raw = (json.dumps(value, separators=(',', ':')) + '\n').encode('ascii')
    if len(raw) > 512 or os.write(1, raw) != len(raw):
        os._exit(3)


def identity(role):
    with open('/proc/self/stat', 'rb') as stream:
        raw = stream.read(4097)
    if len(raw) > 4096:
        os._exit(3)
    fields = raw[raw.rfind(b') ') + 2:].split()
    emit({'type': 'ready', 'role': role, 'pid': os.getpid(),
          'parent': os.getppid(), 'session': os.getsid(0),
          'startTime': fields[19].decode('ascii')})


def main():
    if os.getpid() != 1 or os.getuid() == 0:
        return 3
    child = os.fork()
    role = 'writer'
    if child == 0:
        os.setsid()
        role = 'descendant'
    identity(role)
    # At most 6000 tick rows total, each under 100 bytes; bounded daemon logs.
    # The host experiment normally drains both processes much earlier.
    end = time.monotonic() + 60
    for count in range(1, 3001):
        if time.monotonic() >= end:
            break
        emit({'type': 'tick', 'role': role, 'count': count})
        time.sleep(0.02)
    if child:
        os.waitpid(child, 0)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
