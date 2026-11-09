import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("challenge_checks", ROOT / "challenge_checks.py")
challenge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(challenge)


def portfolio_rows():
    return [
        {"creator_id": f"c{i:02}", "posts": 1, "platform": f"p{i // 5}"}
        for i in range(15)
    ]


class VeeraChecks(unittest.TestCase):
    def canonical(self):
        return {
            f"c{i:02}": {
                "price_per_post_inr": 1000,
                "regional_language": i < 3,
            }
            for i in range(15)
        }

    def by_id(self, checks):
        return {check["id"]: check for check in checks}

    def test_passes_constraints_using_only_organizer_data(self):
        checks = self.by_id(challenge.veera_portfolio_checks(
            {"creators": portfolio_rows()}, self.canonical(),
            fake_labels={f"c{i:02}": False for i in range(15)},
            known_platforms={"p0", "p1", "p2"}, creator_catalog_complete=True,
        ))
        self.assertTrue(all(check["status"] == "PASS" for check in checks.values()))
        self.assertEqual(checks["veera.budget"]["measured"], 15_000)

    def test_rejects_duplicate_ids_posts_budget_platform_share_and_known_fake(self):
        rows = portfolio_rows()
        rows[1]["creator_id"] = rows[0]["creator_id"]
        rows[2]["posts"] = True
        rows[3]["platform"] = "unknown"
        canonical = self.canonical()
        canonical["c00"]["price_per_post_inr"] = 4_000_000
        labels = {f"c{i:02}": False for i in range(15)}
        labels["c00"] = True
        checks = self.by_id(challenge.veera_portfolio_checks(
            {"creators": rows}, canonical, fake_labels=labels,
            known_platforms={"p0", "p1", "p2"}, creator_catalog_complete=True,
        ))
        self.assertEqual(checks["veera.unique_creators"]["status"], "FAIL")
        self.assertEqual(checks["veera.post_counts"]["status"], "FAIL")
        self.assertEqual(checks["veera.known_platforms"]["status"], "FAIL")
        self.assertEqual(checks["veera.exclude_known_fake"]["status"], "FAIL")

    def test_rejects_budget_and_platform_concentration_from_canonical_spend(self):
        canonical = self.canonical()
        canonical["c00"]["price_per_post_inr"] = 4_000_000
        checks = self.by_id(challenge.veera_portfolio_checks(
            {"creators": portfolio_rows()}, canonical,
            fake_labels={f"c{i:02}": False for i in range(15)},
            known_platforms={"p0", "p1", "p2"}, creator_catalog_complete=True,
        ))
        self.assertEqual(checks["veera.budget"]["status"], "FAIL")
        self.assertEqual(checks["veera.platform_spend_share"]["status"], "FAIL")

    def test_requires_exactly_fifteen_rows_even_when_only_fifteen_ids_are_unique(self):
        rows = portfolio_rows()
        rows.append(dict(rows[0]))
        check = self.by_id(challenge.veera_portfolio_checks({"creators": rows}))
        self.assertEqual(check["veera.unique_creators"]["status"], "FAIL")

    def test_missing_organizer_datasets_remain_unverified(self):
        checks = self.by_id(challenge.veera_portfolio_checks(
            {"creators": portfolio_rows()}, None,
            fake_labels=None, known_platforms=None,
        ))
        for name in ("known_creators", "budget", "platform_spend_share",
                     "regional_creators", "exclude_known_fake", "known_platforms"):
            self.assertEqual(checks[f"veera.{name}"]["status"], "UNVERIFIED")

    def test_known_fake_is_failure_even_when_other_labels_are_missing(self):
        labels = {f"c{i:02}": False for i in range(14)}
        labels["c00"] = True
        labels.pop("c13")
        checks = self.by_id(challenge.veera_portfolio_checks(
            {"creators": portfolio_rows()}, self.canonical(), fake_labels=labels,
            known_platforms={"p0", "p1", "p2"}, creator_catalog_complete=True,
        ))
        self.assertEqual(checks["veera.exclude_known_fake"]["status"], "FAIL")


class PricingPulseChecks(unittest.TestCase):
    def by_id(self, checks):
        return {check["id"]: check for check in checks}

    def test_revenue_profit_margin_and_discount_math(self):
        inputs = {
            "price": 100,
            "quantity": 10,
            "total_costs": 600,
            "discount_rate": 0.2,
            "quantity_after_discount": 11,
            "total_costs_after_discount": 660,
        }
        observed = {
            "revenue": 1000,
            "profit": 400,
            "margin_percent": 40,
            "discounted_price": 80,
            "revenue_after_discount": 880,
            "profit_after_discount": 220,
            "margin_after_discount_percent": 25,
        }
        checks = challenge.pricing_arithmetic_checks(inputs, observed, max_discount_rate=1.0)
        self.assertTrue(all(check["status"] == "PASS" for check in checks))

    def test_missing_configured_discount_limit_is_unverified(self):
        checks = self.by_id(challenge.pricing_arithmetic_checks(
            {"price": 10, "quantity": 2, "total_costs": 5,
             "discount_rate": 0.2, "quantity_after_discount": 2,
             "total_costs_after_discount": 5},
            {"revenue": 20, "profit": 15, "margin_percent": 75,
             "discounted_price": 8, "revenue_after_discount": 16,
             "profit_after_discount": 11, "margin_after_discount_percent": 68.75},
        ))
        self.assertEqual(checks["pricingpulse.discount_rate_range"]["status"], "UNVERIFIED")

    def test_zero_revenue_has_explicit_null_margin(self):
        checks = self.by_id(challenge.pricing_arithmetic_checks(
            {"price": 0, "quantity": 8, "total_costs": 0},
            {"revenue": 0, "profit": 0, "margin_percent": None},
        ))
        self.assertEqual(checks["pricingpulse.margin_percent"]["status"], "PASS")

    def test_missing_discount_assumptions_are_unverified(self):
        checks = self.by_id(challenge.pricing_arithmetic_checks(
            {"price": 5, "quantity": 2, "total_costs": 4},
            {"revenue": 10, "profit": 6, "margin_percent": 60},
        ))
        self.assertEqual(checks["pricingpulse.revenue"]["status"], "PASS")
        self.assertEqual(checks["pricingpulse.discounted_price"]["status"], "UNVERIFIED")

    def test_invalid_discount_or_nonfinite_input_requires_explicit_rejection(self):
        for inputs in (
            {"price": 5, "quantity": 2, "total_costs": 4, "discount_rate": -0.1,
             "quantity_after_discount": 3, "total_costs_after_discount": 6},
            {"price": float("nan"), "quantity": 2, "total_costs": 4},
        ):
            accepted = self.by_id(challenge.pricing_arithmetic_checks(inputs, {"status": "OK"}))
            rejected = self.by_id(challenge.pricing_arithmetic_checks(inputs, {"status": "INVALID_INPUT"}))
            self.assertEqual(accepted["pricingpulse.invalid_input_handling"]["status"], "FAIL")
            self.assertEqual(rejected["pricingpulse.invalid_input_handling"]["status"], "PASS")


class MazhaiPrimitives(unittest.TestCase):
    def test_published_metrics_have_no_implicit_score_conversion(self):
        self.assertAlmostEqual(challenge.weighted_mape([110, 180], [100, 200], [1, 3], 1), 10)
        self.assertAlmostEqual(challenge.p99_tail_log_error(110, 100), 0.0953101798, places=8)
        self.assertAlmostEqual(challenge.loss_ratio_penalty_factor(0.7), 0.8)
        self.assertEqual(challenge.loss_ratio_penalty_factor(0.9), 0.0)
        with self.assertRaises(ValueError):
            challenge.p99_tail_log_error(0, 100)


if __name__ == "__main__":
    unittest.main()
