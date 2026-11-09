import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("challenge_benchmarks", ROOT / "challenge_benchmarks.py")
benchmarks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmarks)


class ChallengeBenchmarkFixtures(unittest.TestCase):
    def test_default_bundle_is_exactly_repeatable_and_has_digest(self):
        first = benchmarks.serialize_bundle(benchmarks.generate_bundle())
        second = benchmarks.serialize_bundle(benchmarks.generate_bundle())
        self.assertEqual(first, second)
        bundle = json.loads(first)
        self.assertEqual(bundle["fixtureIntegrity"]["casesDigest"], benchmarks.generate_bundle()["fixtureIntegrity"]["casesDigest"])
        self.assertEqual(bundle["participantEvaluated"], False)
        self.assertIsNone(bundle["marks"])
        self.assertEqual({entry["status"] for entry in bundle["categoryStatuses"].values()}, {"UNVERIFIED"})
        self.assertTrue(all(case["fixtureOnly"] for case in bundle["cases"]))

    def test_seed_changes_cases_without_using_runtime_randomness(self):
        default = benchmarks.generate_bundle("pricingpulse", "seed-a")
        changed = benchmarks.generate_bundle("pricingpulse", "seed-b")
        self.assertNotEqual(default["fixtureIntegrity"]["casesDigest"], changed["fixtureIntegrity"]["casesDigest"])
        self.assertEqual(default, benchmarks.generate_bundle("pricingpulse", "seed-a"))

    def test_pricingpulse_known_answers_and_unverified_elasticity_case(self):
        bundle = benchmarks.generate_bundle("pricingpulse")
        revenue_case = next(case for case in bundle["cases"] if "revenue-profit-margin" in case["id"])
        self.assertEqual(revenue_case["expectedOutput"]["status"], "OK")
        base = {item["id"]: item["status"] for item in revenue_case["oracleEvidence"]}
        self.assertEqual(base["pricingpulse.revenue"], "PASS")
        self.assertEqual(base["pricingpulse.profit"], "PASS")
        self.assertEqual(base["pricingpulse.margin_percent"], "PASS")
        elasticity = next(case for case in bundle["cases"] if "elasticity-unverified" in case["id"])
        self.assertIsNone(elasticity["expectedOutput"])
        self.assertEqual(elasticity["oracleEvidence"][0]["status"], "UNVERIFIED")

    def test_veera_constraints_are_synthetic_and_missing_hidden_data_stays_unverified(self):
        cases = benchmarks.generate_bundle("veera-footwear")["cases"]
        valid = next(case for case in cases if "synthetic-valid-constraints" in case["id"])
        checks = {check["id"]: check for check in valid["oracleEvidence"]}
        self.assertEqual(checks["veera.unique_creators"]["status"], "PASS")
        self.assertEqual(checks["veera.budget"]["status"], "PASS")
        hidden = next(case for case in cases if "hidden-buyer-simulator-unverified" in case["id"])
        self.assertEqual(hidden["oracleEvidence"][0]["status"], "UNVERIFIED")
        self.assertIn("synthetic", valid["purpose"])

    def test_mazhai_formula_oracle_does_not_map_to_marks(self):
        bundle = benchmarks.generate_bundle("mazhai-cover")
        case = bundle["cases"][0]
        self.assertGreater(case["referenceMetrics"]["weightedMapePercent"], 0)
        self.assertGreater(case["referenceMetrics"]["p99TailLogError"], 0)
        self.assertIsNone(bundle["marks"])
        self.assertEqual(bundle["categoryStatuses"]["functionalCorrectness"]["status"], "UNVERIFIED")

    def test_cli_repeatability_flag_emits_valid_local_artifact(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "challenge_benchmarks.py"), "--challenge", "pricingpulse", "--verify-repeatability"],
            check=True,
            capture_output=True,
            text=True,
        )
        bundle = json.loads(result.stdout)
        self.assertEqual(bundle["format"], "doomforge.challenge-benchmark-fixtures")
        self.assertEqual(bundle["fixtureVersion"], "1.0.0")
        self.assertFalse(bundle["officialScoring"])


if __name__ == "__main__":
    unittest.main()
