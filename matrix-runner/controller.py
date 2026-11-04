"""Trusted parent. Participant modules are imported only in a bounded child."""
import base64
import binascii
import ctypes
import datetime
import errno
import json
import math
import os
from pathlib import Path, PurePosixPath
import resource
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
MATRICES = json.loads((HERE / 'matrices.json').read_text())
MAX_INPUT = 68 * 1024 * 1024
MAX_OUTPUT = 1024 * 1024
WALL_SECONDS = 12


def validate_snapshot(payload):
    if not isinstance(payload, dict) or payload.get('repository') not in MATRICES:
        raise ValueError('unsupported repository')
    files = payload.get('files')
    if not isinstance(files, list) or len(files) > 250:
        raise ValueError('invalid file count')
    decoded, total = {}, 0
    for item in files:
        if not isinstance(item, dict) or set(item) != {'path', 'base64'}:
            raise ValueError('invalid snapshot entry')
        name = item['path']
        if not isinstance(name, str) or len(name) > 240 or '\\' in name or '\x00' in name:
            raise ValueError('invalid path')
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or str(path) != name or name in decoded:
            raise ValueError('unsafe or duplicate path')
        # No control files, secrets, symlinks, executable metadata or judging files.
        if not name.startswith('src/') or path.suffix != '.py' or any(p.startswith('.') for p in path.parts):
            raise ValueError('only src Python files accepted')
        try:
            value = base64.b64decode(item['base64'], validate=True)
        except (ValueError, TypeError, binascii.Error) as exc:
            raise ValueError('invalid base64') from exc
        total += len(value)
        if len(value) > 40 * 1024 * 1024 or total > 48 * 1024 * 1024:
            raise ValueError('snapshot byte limit')
        decoded[name] = value
    return payload['repository'], decoded


def compare(expected, observed):
    if isinstance(expected, bool):
        return type(observed) is bool and observed == expected
    if isinstance(expected, (int, float)):
        try:
            return (type(observed) in (int, float) and math.isfinite(observed)
                    and math.isclose(expected, observed, rel_tol=1e-7, abs_tol=1e-7))
        except (OverflowError, ValueError):
            return False
    if isinstance(expected, list):
        return isinstance(observed, list) and len(expected) == len(observed) and all(compare(a,b) for a,b in zip(expected, observed))
    if isinstance(expected, dict):
        return isinstance(observed, dict) and expected.keys() == observed.keys() and all(compare(v,observed[k]) for k,v in expected.items())
    return type(expected) is type(observed) and expected == observed


def fixture(check_id):
    """Fresh organizer-generated probes; no private datasets or solution imports."""
    if '.dedupe-' in check_id or check_id.endswith('dedupe-content'):
        n = int(check_id.rsplit('-',1)[1]) if '.scale.' in check_id else 7
        rows = [dict(txn_id=f'T{i:06}',value_date='2026-08-03',post_date='2026-08-04',account='current',direction='CREDIT',category='WAGES' if i%2 else 'EXPORT_RECEIPT',counterparty_id=f'B{i}',amount_inr=float(i+17),currency='INR',amount_fcy=0.0,narration=f'item {i}') for i in range(n)]
        rows += [dict(rows[i],txn_id=f'Z{i:06}') for i in range(0,n,3)]
        return {'op':'dedupe','rows':rows}, [f'T{i:06}' for i in range(n)], 'src/noyyal/clean/dedupe.py'
    if 'forecast-' in check_id:
        control = [dict(week_start=str(datetime.date(2026,8,3)+datetime.timedelta(weeks=i)),
                        inflow_p50_inr=120.0,outflow_p50_inr=20.0,
                        net_p10_inr=80.0,net_p50_inr=100.0,net_p90_inr=120.0,
                        closing_p10_inr=1000.0+80*(i+1),
                        closing_p50_inr=1000.0+100*(i+1),
                        closing_p90_inr=1000.0+120*(i+1)) for i in range(13)]
        rows = [dict(row) for row in control]
        if check_id.endswith('nan'):
            rows[0]['net_p50_inr'] = None
        else:
            rows[1]['week_start'] = rows[0]['week_start']
        return {'op':'forecast-reject','control':control,'rows':rows}, {'validAccepted':True,'invalidRejected':True}, 'src/noyyal/submission.py'
    if check_id.endswith('fx-conversion'):
        values = [dict(amount=123.5,currency='USD'),dict(amount=48.0,currency='EUR'),dict(amount=77.0,currency='INR')]
        return {'op':'fx','values':values,'fx':{'usdinr_spot':83.25,'eurinr_spot':91.75}}, [10281.375,4404.0,77.0], 'src/noyyal/io/fx.py'
    if '.profit-' in check_id or check_id.endswith('incremental-profit'):
        n = int(check_id.rsplit('-',1)[1]) if '.scale.' in check_id else 9
        a = [0.2+(i%11)/10 for i in range(n)]
        b = [v+(i%7)/8 for i,v in enumerate(a)]
        c = [110.0+(i%17)*13 for i in range(n)]
        expected = [55*(y-x)-0.1*z*(1-math.exp(-y)) for x,y,z in zip(a,b,c)]
        return {'op':'profit','a':a,'b':b,'c':c,'discount':10.0}, expected, 'src/rasoi/simulate/revenue.py'
    if check_id.endswith('discount-cost'):
        values = [[10.0,380.0,0.0],[20.0,730.0,0.42],[10.0,215.0,1.0]]
        return {'op':'cost','values':values}, [0.0,61.32,21.5], 'src/rasoi/assignment/budget.py'
    if '.security.' in check_id:
        # Parent independently evaluates offer membership, opt-out and actual cost.
        optout = check_id.endswith('opt-out')
        return {'op':'offers','optout':optout,'budget':0.0 if not optout else 10000.0}, None, 'src/rasoi/assignment/budget.py'
    raise ValueError('unknown check')


def security_offers(request, observed):
    if not isinstance(observed,list) or len(observed) != 4 or any(x not in ('NONE','OFFER_10','OFFER_20') for x in observed):
        return False
    if request['optout'] and any(x != 'NONE' for x in observed):
        return False
    cost = sum(20.0 if x=='OFFER_10' else 50.0 if x=='OFFER_20' else 0.0 for x in observed)
    return cost <= request['budget'] + 1e-7


def limits():
    os.setsid()
    resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024,)*2)
    resource.setrlimit(resource.RLIMIT_CPU, (8,8))
    resource.setrlimit(resource.RLIMIT_FSIZE, (8*1024*1024,)*2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (32,32))
    resource.setrlimit(resource.RLIMIT_NPROC, (1,1))
    resource.setrlimit(resource.RLIMIT_CORE, (0,0))
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38,1,0,0,0) != 0:
        raise RuntimeError('no_new_privs unavailable')
    # Installed before exec and inherited; cannot be undone by participant code.
    lib = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint]
    class ArgComparison(ctypes.Structure):
        _fields_ = [('arg',ctypes.c_uint),('op',ctypes.c_int),
                    ('datum_a',ctypes.c_uint64),('datum_b',ctypes.c_uint64)]
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p,ctypes.c_uint32,
                                          ctypes.c_int,ctypes.c_uint,
                                          ctypes.POINTER(ArgComparison)]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    ctx = lib.seccomp_init(0x7fff0000)
    if not ctx:
        raise RuntimeError('seccomp unavailable')
    for name in ('socket','socketpair','fork','vfork','clone','clone3','unshare','setns','mount','umount2','ptrace','process_vm_readv','process_vm_writev','bpf','keyctl','perf_event_open','io_uring_setup','io_uring_enter','io_uring_register','userfaultfd','open_by_handle_at','pidfd_getfd','creat','openat2','mkdir','mkdirat','mknod','mknodat','link','linkat','symlink','symlinkat','rename','renameat','renameat2','unlink','unlinkat','rmdir','truncate','ftruncate'):
        number = lib.seccomp_syscall_resolve_name(name.encode())
        if number >= 0 and lib.seccomp_rule_add(ctx,0x50000 | errno.EPERM,number,0) != 0:
            raise RuntimeError('seccomp rule unavailable')
    # The matrix is pure read-only functions. Deny every write/create open,
    # including /dev/shm and /proc/self/fd aliases, independently of mounts.
    for name,argument in (('open',1),('openat',2)):
        number = lib.seccomp_syscall_resolve_name(name.encode())
        if number < 0:
            continue
        for bit in (os.O_WRONLY,os.O_RDWR,os.O_CREAT,os.O_TRUNC,os.O_APPEND):
            comparison = ArgComparison(argument,7,bit,bit)  # MASKED_EQ
            if lib.seccomp_rule_add_array(ctx,0x50000 | errno.EPERM,number,1,ctypes.byref(comparison)) != 0:
                raise RuntimeError('read-only seccomp rule unavailable')
    if lib.seccomp_load(ctx) != 0:
        raise RuntimeError('seccomp load failed')
    lib.seccomp_release(ctx)
    os.setgroups([])
    os.setgid(65534)
    os.setuid(65534)


def run_child(directory, request):
    env = {'PATH':'/usr/local/bin:/usr/bin:/bin','PYTHONPATH':str(directory/'src'),
           'HOME':str(directory),'TMPDIR':str(directory/'tmp'),'PYTHONDONTWRITEBYTECODE':'1',
           'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','MKL_NUM_THREADS':'1'}
    proc = subprocess.Popen([sys.executable,str(HERE/'probe.py')],cwd=directory,env=env,
                            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                            preexec_fn=limits)
    selector = selectors.DefaultSelector()
    for stream in (proc.stdout,proc.stderr):
        os.set_blocking(stream.fileno(),False)
        selector.register(stream,selectors.EVENT_READ)
    # Requests are below pipe capacity only for small probes; send larger inputs via file.
    # Input file was written by root and opened read-only before unprivileged exec.
    proc.stdin.close()
    chunks = {proc.stdout:bytearray(),proc.stderr:bytearray()}
    deadline = time.monotonic()+WALL_SECONDS
    failure = None
    try:
        while selector.get_map():
            if time.monotonic() > deadline:
                failure = 'bounded workload exceeded 12s wall limit'
                break
            for key,_ in selector.select(0.05):
                data = os.read(key.fileobj.fileno(),65536)
                if not data:
                    selector.unregister(key.fileobj)
                else:
                    chunks[key.fileobj].extend(data)
                    if sum(map(len,chunks.values())) > MAX_OUTPUT:
                        failure = 'participant output exceeded 1MiB'
                        break
            if failure:
                break
    finally:
        try: os.killpg(proc.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        proc.wait()
        selector.close()
        proc.stdout.close()
        proc.stderr.close()
    started = b'JUDGE_WORKLOAD_STARTED\n' in chunks[proc.stderr]
    if failure:
        return None, failure, started
    if proc.returncode != 0:
        return None, 'participant workload terminated or raised an exception', started
    try:
        return json.loads(chunks[proc.stdout]), None, started
    except (ValueError, UnicodeDecodeError, RecursionError):
        return None, 'participant output is not a single JSON value', started


def evaluate(payload):
    repo, files = validate_snapshot(payload)
    results = []
    for check in MATRICES[repo]['checks']:
        start = time.monotonic()
        request, expected, required = fixture(check['id'])
        status, detail = 'UNVERIFIED', 'required source module missing'
        if required in files:
            if sys.platform != 'linux' or os.geteuid() != 0:
                detail = 'Linux root controller with seccomp required'
            else:
                directory = Path(tempfile.mkdtemp(prefix='probe-',dir='/work'))
                try:
                    os.chmod(directory,0o755)
                    for name,content in files.items():
                        target = directory/name
                        target.parent.mkdir(parents=True,exist_ok=True)
                        target.write_bytes(content)
                        target.chmod(0o444)
                    (directory/'request.json').write_text(json.dumps(request,allow_nan=False))
                    (directory/'request.json').chmod(0o444)
                    scratch = directory/'tmp'
                    scratch.mkdir(mode=0o555)
                    observed,error,started = run_child(directory,request)
                    if error:
                        status = 'FAIL' if started else 'UNVERIFIED'
                        detail = error
                    else:
                        passed = security_offers(request,observed) if request['op']=='offers' else compare(expected,observed)
                        status = 'PASS' if passed else 'FAIL'
                        detail = ('trusted parent verified expected output' if passed else 'output differs from trusted expected result')
                    detail += '; limits: wall12s CPU8s AS512MiB output1MiB; isolated fresh subprocess'
                except (OSError,subprocess.SubprocessError) as exc:
                    status,detail = 'UNVERIFIED','isolation or subprocess setup failed: '+type(exc).__name__
                finally:
                    shutil.rmtree(directory)
        results.append({'id':check['id'],'category':check['category'],'status':status,'durationMs':round((time.monotonic()-start)*1000),'detail':detail})
    return {'checks':results}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT+1)
        if len(raw)>MAX_INPUT:
            raise ValueError('request limit exceeded')
        result = evaluate(json.loads(raw))
    except (ValueError,TypeError,RecursionError) as exc:
        result = {'checks':[], 'error':str(exc)[:160]}
    print(json.dumps(result,allow_nan=False,separators=(',',':')))

if __name__ == '__main__': main()
