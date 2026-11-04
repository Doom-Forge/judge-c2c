"""Untrusted child adapter. Its outputs are data, never judging decisions."""
import json
import sys
from pathlib import Path

request = json.loads(Path('request.json').read_text())
sys.stderr.write('JUDGE_WORKLOAD_STARTED\n')
sys.stderr.flush()
# Imports below this point may execute hostile participant code.
import numpy as np
import pandas as pd

op = request['op']
if op == 'dedupe':
    from noyyal.clean.dedupe import drop_statement_duplicates
    result = drop_statement_duplicates(pd.DataFrame(request['rows']))['txn_id'].tolist()
elif op == 'forecast-reject':
    from noyyal.submission import validate_forecast, SubmissionError
    result = {'validAccepted':False,'invalidRejected':False}
    try:
        validate_forecast(pd.DataFrame(request['control']))
        result['validAccepted'] = True
    except SubmissionError:
        pass
    try:
        validate_forecast(pd.DataFrame(request['rows']))
    except SubmissionError:
        result['invalidRejected'] = True
elif op == 'fx':
    from noyyal.io.fx import to_inr
    result = [float(to_inr(row['amount'],row['currency'],request['fx'])) for row in request['values']]
elif op == 'profit':
    from rasoi.simulate.revenue import incremental_profit
    result = np.asarray(incremental_profit(np.array(request['a']),np.array(request['b']),np.array(request['c']),request['discount'])).tolist()
elif op == 'cost':
    from rasoi.assignment.budget import expected_discount_cost
    result = [float(expected_discount_cost(*v)) for v in request['values']]
elif op == 'offers':
    from rasoi.assignment.budget import select_offers
    customers = pd.DataFrame({'customer_id':['a','b','c','d'],'avg_order_value_inr':[100.0]*4,'promo_opt_out':[request['optout']]*4})
    result = select_offers(customers,np.array([0.1]*4),np.array([2.0]*4),np.array([2.5]*4),budget_inr=request['budget']).tolist()
else:
    raise ValueError('unknown operation')
print(json.dumps(result,allow_nan=False))
