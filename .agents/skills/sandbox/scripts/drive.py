import collections
import fcntl
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import tty

KEYS = {
    'up': '\x1b[A',
    'down': '\x1b[B',
    'right': '\x1b[C',
    'left': '\x1b[D',
    'shift-up': '\x1b[1;2A',
    'shift-down': '\x1b[1;2B',
    'shift-right': '\x1b[1;2C',
    'shift-left': '\x1b[1;2D',
    'home': '\x1b[H',
    'end': '\x1b[F',
    'pgup': '\x1b[5~',
    'pgdn': '\x1b[6~',
    'enter': '\r',
    'esc': '\x1b',
    'tab': '\t',
    'space': ' ',
    'bs': '\x7f',
    'ctrl-c': '\x03',
    'ctrl-u': '\x15',
    'shift-tab': '\x1b[Z',
    'alt-c': '\x1bc',
    'alt-g': '\x1bg',
    'ctrl-v': '\x16',
    'alt-v': '\x1bv',
    'focus-in': '\x1b[I',
    'focus-out': '\x1b[O',
}

GAP = 0.25
REPEAT = 0.03
POSTED = set(KEYS) - {'focus-in', 'focus-out'}
LINGER = float(os.environ.get('SB_LINGER') or 10)
WAIT = 10.0
PENDING = object()


def real(step):
    if not os.environ.get('SB_KEYS'):
        return None
    if step in POSTED or (len(step) == 1 and step.isascii()):
        return 0.0
    if step.startswith('text:'):
        return 0.03 * (len(step) - 5)
    return None


def keys(step):
    if step.startswith('text:'):
        return list(step[5:]), GAP
    if step.startswith('paste:'):
        return [f'\x1b[200~{step[6:]}\x1b[201~'], GAP
    if step in KEYS:
        return [KEYS[step]], GAP
    for name, report in (('move', '35;{};{}M'), ('press', '0;{};{}M'), ('release', '0;{};{}m')):
        if step.startswith(f'{name}:'):
            return ['\x1b[<' + report.format(*step[len(name) + 1:].split(':'))], GAP
    if step.startswith('hold:'):
        key, _, count = step[5:].rpartition(':')
        if key in KEYS and count.isdigit():
            return [KEYS[key]] * int(count), REPEAT
    if len(step) == 1:
        return [step], GAP
    raise SystemExit(f'drive.py: unknown step {step!r}')


class Trace:
    def __init__(self):
        self.fd = None
        self.lines = []
        self.ids = f'{os.getpid()}\t{os.getppid()}'
        path = os.environ.get('TTHEME_TRACE')
        if path:
            try:
                self.fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
            except OSError:
                self.fd = None

    def mark(self, name, detail=''):
        if self.fd is not None:
            detail = detail.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')
            self.lines.append(f'{time.time():.6f}\t{self.ids}\tdrive\t{name}\t{detail}\n')

    def flush(self):
        if self.lines:
            os.write(self.fd, ''.join(self.lines).encode())
            self.lines = []


class Screen:
    def __init__(self, size):
        rows, cols = struct.unpack('HHHH', size)[:2]
        helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'screen.mjs')
        self.asked = None
        self.reply = b''
        self.behind = False
        self.broken = False
        self.held = collections.deque()
        self.head = 0
        try:
            self.proc = subprocess.Popen(['node', helper, str(cols), str(rows)], stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, bufsize=0)
        except OSError:
            self.proc = None
            return
        os.set_blocking(self.proc.stdin.fileno(), False)

    def send(self, kind, body=b''):
        if self.proc is None or self.broken:
            return False
        self.held.append(kind + struct.pack('>I', len(body)) + body)
        return True

    def owed(self):
        return [self.proc.stdin.fileno()] if self.held and self.proc is not None and not self.broken else []

    def push(self):
        fd = self.proc.stdin.fileno()
        while self.held:
            chunk = self.held[0]
            try:
                self.head += os.write(fd, memoryview(chunk)[self.head:])
            except BlockingIOError:
                return
            except OSError:
                self.broken = True
                self.held.clear()
                return
            if self.head < len(chunk):
                return
            self.held.popleft()
            self.head = 0

    def feed(self, data):
        self.send(b'd', data)

    def ask(self):
        if self.asked is None:
            if not self.send(b't'):
                return False
            self.asked = time.monotonic()
            self.reply = b''
        return True

    def waiting(self):
        return [self.proc.stdout.fileno()] if self.asked is not None and self.proc is not None else []

    def heard(self, readable):
        if self.asked is None:
            return PENDING
        if self.proc is None or self.broken:
            self.asked = None
            return None
        fd = self.proc.stdout.fileno()
        if fd not in readable:
            if time.monotonic() - self.asked > WAIT:
                self.asked = None
                self.behind = True
                return None
            return PENDING
        chunk = os.read(fd, 65536)
        if not chunk:
            self.proc = None
            self.asked = None
            return None
        self.reply += chunk
        if not self.reply.endswith(b'\0'):
            return PENDING
        self.asked = None
        return self.reply[:-1].decode('utf-8', 'replace')

    def why(self):
        if self.behind:
            return f'the screen text did not come within {WAIT:g} s'
        return 'no screen text (node or @xterm/headless missing)'

    def close(self):
        if self.proc is None:
            return
        self.broken = True
        self.held.clear()
        self.proc.kill()
        self.proc.wait()
        self.proc = None


def spawn(command, size):
    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        if slave > 2:
            os.close(slave)
        os.execvp('zsh', ['zsh', '-i', '-c', command])
    os.close(slave)
    return pid, master


def main():
    args = sys.argv[1:]
    hand = args[:1] == ['--hand']
    if hand:
        args = args[1:]
    if not args:
        raise SystemExit('usage: drive.py [--hand] COMMAND [STEP…]  — a step is a key, text:…, paste:…, seconds, wait:TEXT or shot:NAME; --hand leaves the keys to the person once the steps are done')
    command, steps = args[0], args[1:]
    shots = os.path.join(os.environ.get('ZDOTDIR') or os.environ['HOME'], 'shots')
    term = os.open('/dev/tty', os.O_RDWR)
    size = fcntl.ioctl(term, termios.TIOCGWINSZ, b'\0' * 8)
    pid, master = spawn(command, size)
    screen = Screen(size)
    trace = Trace()
    failed = False
    late = ''
    saved = termios.tcgetattr(term)
    tty.setraw(term)
    status = None
    if hand:
        signal.signal(
            signal.SIGWINCH,
            lambda *_: fcntl.ioctl(master, termios.TIOCSWINSZ, fcntl.ioctl(term, termios.TIOCGWINSZ, b'\0' * 8)),
        )
    try:
        at = time.monotonic() + GAP
        pending = []
        gap = GAP
        opening = None
        shot = None
        done = None
        waiting = None
        poll = 0.0
        poster = None
        readable = []
        while True:
            now = time.monotonic()
            seen = screen.heard(readable)
            if shot:
                if seen is not PENDING:
                    if seen is not None:
                        with open(f'{shot}.screen', 'w') as out:
                            out.write(seen + '\n')
                    shot = None
                    at = now
                elif screen.asked is None and (os.path.exists(f'{shot}.done') or os.path.exists(f'{shot}.skip')):
                    if not screen.ask():
                        shot = None
                        at = now
            elif waiting:
                if seen is PENDING and screen.asked is None and now >= poll and not screen.ask():
                    seen = None
                if seen is PENDING:
                    pass
                elif seen is not None and waiting[0] in seen:
                    waiting = None
                    at = now
                elif seen is None or now >= waiting[1]:
                    why = f'not on the screen after {WAIT:g} s' if seen is not None else screen.why()
                    if hand:
                        late = f'drive.py: wait:{waiting[0]} — {why}\n'
                    else:
                        sys.stderr.write(f'drive.py: wait:{waiting[0]} — {why}\n{seen or ""}\n')
                        done = now - LINGER
                    failed = True
                    waiting = None
                    steps, pending = [], []
                else:
                    poll = now + 0.1
            elif pending and now >= at:
                if opening is not None:
                    trace.mark('input.sent', opening)
                    opening = None
                os.write(master, pending.pop(0).encode())
                at = now + (gap if pending else GAP)
            elif steps and now >= at:
                step = steps.pop(0)
                if step.startswith('shot:'):
                    os.makedirs(shots, exist_ok=True)
                    shot = os.path.join(shots, step[5:])
                    open(f'{shot}.req', 'w').close()
                elif step.startswith('wait:'):
                    waiting = (step[5:], now + WAIT)
                    poll = now
                else:
                    try:
                        at = now + float(step)
                    except ValueError:
                        typing = real(step)
                        if typing is None:
                            pending, gap = keys(step)
                            opening = step
                        else:
                            if poster is None:
                                poster = open(os.environ['SB_KEYS'], 'w', buffering=1)
                            poster.write(step + '\n')
                            at = now + typing + GAP
            elif not steps and not pending and not shot and not waiting and done is None:
                done = now
                if hand:
                    screen.close()
            if not hand and done is not None and now - done > LINGER:
                os.kill(pid, signal.SIGHUP)
                done = now
            readable, writable, _ = select.select([master, term, *screen.waiting()], screen.owed(), [],
                                                  1 if hand and done is not None else 0.02)
            if writable:
                screen.push()
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b''
                if data:
                    os.write(term, data)
                    trace.mark('relay.out', str(len(data)))
                    screen.feed(data)
                elif status is not None:
                    break
            if term in readable:
                data = os.read(term, 4096)
                if data:
                    os.write(master, data)
                    trace.mark('relay.in', str(len(data)))
            trace.flush()
            if status is None:
                waited, code = os.waitpid(pid, os.WNOHANG)
                if waited:
                    status = os.waitstatus_to_exitcode(code)
                    if master not in select.select([master], [], [], 0.05)[0]:
                        break
    finally:
        termios.tcsetattr(term, termios.TCSADRAIN, saved)
        screen.close()
        trace.flush()
    sys.stderr.write(late)
    return 1 if failed else status or 0


sys.exit(main())
