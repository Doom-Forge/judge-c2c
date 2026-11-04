"""Run with MATRIX_IMAGE=doomforge-matrix:test after building image."""
import base64
import json
import os
import subprocess
import unittest

IMAGE = os.environ.get('MATRIX_IMAGE')

@unittest.skipUnless(IMAGE, 'Docker image opt-in required')
class ContainerTests(unittest.TestCase):
    def run_snapshot(self, files, repo='rasoi-offer-roulette'):
        request = {'repository':repo, 'files':[{'path':p,'base64':base64.b64encode(v.encode()).decode()} for p,v in files.items()]}
        proc = subprocess.run(['docker','--context','default','run','--rm','-i','--network=none','--read-only','--tmpfs','/work:rw,nosuid,nodev,size=128m','--pids-limit','64','--memory','768m',IMAGE,'python','/opt/judge/controller.py'], input=json.dumps(request), text=True, capture_output=True, timeout=180)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)['checks']

    def test_correct_rasoi_functions_pass_and_wrong_formula_fails(self):
        source = 'import numpy as np\ndef incremental_profit(a,b,c,d): return 55*(np.asarray(b)-np.asarray(a))-(d/100)*np.asarray(c)*(1-np.exp(-np.asarray(b)))\n'
        budget = 'import pandas as pd\ndef expected_discount_cost(d,a,p): return d/100*a*p\ndef select_offers(customers,p0,p10,p20,budget_inr): return pd.Series(["NONE"]*len(customers))\n'
        files = {'src/rasoi/simulate/revenue.py':source,'src/rasoi/assignment/budget.py':budget}
        results = self.run_snapshot(files)
        self.assertTrue(all(x['status']=='PASS' for x in results), results)
        files['src/rasoi/simulate/revenue.py'] = 'def incremental_profit(*a): return 0\n'
        results = self.run_snapshot(files)
        self.assertTrue(any(x['status']=='FAIL' for x in results))

    def test_correct_noyyal_passes_and_missing_validation_fails(self):
        files = {
            'src/noyyal/clean/dedupe.py': "def drop_statement_duplicates(frame): return frame.drop_duplicates(subset=[x for x in frame.columns if x!='txn_id']).sort_values(['value_date','txn_id']).reset_index(drop=True)\n",
            'src/noyyal/io/fx.py': "def to_inr(amount,currency,fx): return amount*(1 if currency=='INR' else fx['usdinr_spot' if currency=='USD' else 'eurinr_spot'])\n",
            'src/noyyal/submission.py': "class SubmissionError(ValueError): pass\ndef validate_forecast(frame):\n if frame.isna().any().any() or frame.week_start.duplicated().any(): raise SubmissionError('invalid')\n"
        }
        results = self.run_snapshot(files, 'noyyal-treasury')
        self.assertTrue(all(x['status']=='PASS' for x in results), results)
        files['src/noyyal/submission.py'] = "class SubmissionError(ValueError): pass\ndef validate_forecast(frame): pass\n"
        results = self.run_snapshot(files, 'noyyal-treasury')
        self.assertTrue(all(x['status']=='FAIL' for x in results if x['category']=='security'), results)

    def test_unconditional_forecast_rejection_fails_positive_control(self):
        source = "class SubmissionError(ValueError): pass\ndef validate_forecast(frame): raise SubmissionError('reject everything')\n"
        results = self.run_snapshot({'src/noyyal/submission.py':source}, 'noyyal-treasury')
        self.assertTrue(all(x['status']=='FAIL' for x in results if x['category']=='security'), results)

    def test_stdout_forgery_is_not_a_judge_result(self):
        results = self.run_snapshot({'src/rasoi/simulate/revenue.py':'print("{\\"checks\\":[{\\"status\\":\\"PASS\\"}]}")\ndef incremental_profit(*a): return 123\n'})
        self.assertTrue(all(x['status']!='PASS' for x in results))

    def test_child_cannot_modify_rules_or_fork_or_open_network(self):
        source = '''import os,socket,resource
assert os.getuid()==65534 and os.getgid()==65534
assert resource.getrlimit(resource.RLIMIT_AS)[0]==512*1024*1024
assert resource.getrlimit(resource.RLIMIT_CPU)[0]==8
for path in ['/opt/judge/controller.py','/etc/passwd','/dev/shm/participant-write','/work/participant-write']:
 try:
  with open(path,'a') as f: f.write('corrupt')
 except OSError as exc: assert exc.errno in (1,13,30)
 else: raise RuntimeError('writable rules')
try: socket.socket()
except PermissionError: pass
else: raise RuntimeError('network allowed')
try: os.fork()
except PermissionError: pass
else: raise RuntimeError('fork allowed')
import numpy as np
def incremental_profit(a,b,c,d): return 55*(np.asarray(b)-np.asarray(a))-(d/100)*np.asarray(c)*(1-np.exp(-np.asarray(b)))
'''
        results = self.run_snapshot({'src/rasoi/simulate/revenue.py':source})
        self.assertTrue(all(x['status']=='PASS' for x in results if x['category']=='scalability'), results)

    def test_deep_json_cannot_crash_trusted_parent(self):
        results = self.run_snapshot({'src/rasoi/simulate/revenue.py':"print('['*20000+']'*20000)\nraise SystemExit(0)\n"})
        self.assertTrue(all(x['status'] in ['FAIL','UNVERIFIED'] for x in results))

    def test_huge_numeric_output_cannot_crash_trusted_parent(self):
        results = self.run_snapshot({'src/rasoi/simulate/revenue.py':"def incremental_profit(*a): return [10**1000]*len(a[0])\n"})
        self.assertTrue(all(x['status'] in ['FAIL','UNVERIFIED'] for x in results))

    def test_excess_output_is_bounded(self):
        results = self.run_snapshot({'src/rasoi/simulate/revenue.py':"print('x'*2000000)\n"})
        self.assertTrue(all(x['status'] in ['FAIL','UNVERIFIED'] for x in results))

    def test_infinite_import_is_bounded(self):
        results = self.run_snapshot({'src/rasoi/simulate/revenue.py':'while True: pass\n'})
        self.assertTrue(all(x['status'] in ['FAIL','UNVERIFIED'] for x in results))

if __name__ == '__main__': unittest.main()
