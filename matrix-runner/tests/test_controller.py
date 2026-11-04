import base64
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]

class ControllerTests(unittest.TestCase):
    def controller(self):
        spec = importlib.util.spec_from_file_location('controller', ROOT / 'controller.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_rejects_escape_duplicate_malformed_and_excess_file_count(self):
        c = self.controller()
        self.assertEqual(c.validate_snapshot({'repository':'noyyal-treasury','files':[{'path':'src/x.py','base64':'eA=='}]})[1], {'src/x.py':b'x'})
        for files in ([{'path':'../escape','base64':'eA=='}],
                      [{'path':'src/x.py','base64':'eA=='}, {'path':'src/x.py','base64':'eA=='}],
                      [{'path':'/etc/passwd','base64':'eA=='}],
                      [{'path':'src/x.py','base64':'!!!'}],
                      [{'path':f'src/x{i}.py','base64':''} for i in range(251)]):
            with self.assertRaises(ValueError):
                c.validate_snapshot({'repository':'noyyal-treasury','files':files})

    def test_forecast_abuse_has_valid_weekly_positive_control(self):
        import datetime
        c = self.controller()
        for kind in ('nan','duplicate-weeks'):
            request, expected, _ = c.fixture('noyyal.security.forecast-'+kind)
            self.assertIn('control', request)
            dates = [datetime.date.fromisoformat(row['week_start']) for row in request['control']]
            self.assertTrue(all(d.weekday()==0 for d in dates))
            self.assertTrue(all((b-a).days==7 for a,b in zip(dates,dates[1:])))
            self.assertEqual(sum(a[k]!=b[k] for a,b in zip(request['rows'],request['control']) for k in a),1)
            self.assertEqual(expected, {'validAccepted':True,'invalidRejected':True})

    def test_empty_repository_returns_six_unverified_without_importing(self):
        c = self.controller()
        for repo in c.MATRICES:
            results = c.evaluate({'repository':repo, 'files':[]})['checks']
            self.assertEqual(len(results), 6)
            self.assertTrue(all(x['status'] == 'UNVERIFIED' for x in results))

    def test_parent_oracle_rejects_forged_pass(self):
        c = self.controller()
        self.assertFalse(c.compare({'x':1}, {'status':'PASS','checks':[]}))
        self.assertFalse(c.compare([1.0], [float('nan')]))
        self.assertTrue(c.compare([1.0], [1.00000001]))
        self.assertFalse(c.compare(1.0, 10**1000))

if __name__ == '__main__':
    unittest.main()
