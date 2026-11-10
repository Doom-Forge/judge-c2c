"""Organizer-authored synthetic implementations, not participant/reference solutions.

python matrix-runner/tests/canaries.py noyyal-treasury [--fail]
Emits a controller stdin snapshot for deployment smoke tests.
"""
import base64
import json
import sys


def snapshot(repository, fail=False):
    if repository == 'noyyal-treasury':
        files = {
            'src/noyyal/clean/dedupe.py': "def drop_statement_duplicates(frame): return frame.drop_duplicates(subset=[x for x in frame.columns if x!='txn_id']).sort_values(['value_date','txn_id']).reset_index(drop=True)\n",
            'src/noyyal/io/fx.py': "def to_inr(amount,currency,fx): return amount*(1 if currency=='INR' else fx['usdinr_spot' if currency=='USD' else 'eurinr_spot'])\n",
            'src/noyyal/submission.py': "class SubmissionError(ValueError): pass\ndef validate_forecast(frame):\n if frame.isna().any().any() or frame.week_start.duplicated().any(): raise SubmissionError('invalid')\n"
        }
        if fail:
            files['src/noyyal/submission.py'] = 'class SubmissionError(ValueError): pass\ndef validate_forecast(frame): pass\n'
    elif repository == 'rasoi-offer-roulette':
        files = {
            'src/rasoi/simulate/revenue.py': 'import numpy as np\ndef incremental_profit(a,b,c,d): return 55*(np.asarray(b)-np.asarray(a))-(d/100)*np.asarray(c)*(1-np.exp(-np.asarray(b)))\n',
            'src/rasoi/assignment/budget.py': 'import pandas as pd\ndef expected_discount_cost(d,a,p): return d/100*a*p\ndef select_offers(customers,p0,p10,p20,budget_inr): return pd.Series(["NONE"]*len(customers))\n'
        }
        if fail:
            files['src/rasoi/simulate/revenue.py'] = 'def incremental_profit(*a): return 0\n'
    else:
        raise ValueError('unknown repository')
    return {'repository':repository,'files':[{'path':path,'base64':base64.b64encode(value.encode()).decode()} for path,value in files.items()]}

if __name__ == '__main__':
    print(json.dumps(snapshot(sys.argv[1], '--fail' in sys.argv[2:])))
