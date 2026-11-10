#!/usr/bin/env python3
"""Generate local deterministic challenge-spec fixtures, never participant scores."""

import argparse
import hashlib
import json
from pathlib import Path

import challenge_checks

SEED_DEFAULT = "doomforge-challenge-fixtures-v1"
FIXTURE_VERSION = "1.0.0"
CHALLENGES = ("pricingpulse", "veera-footwear", "mazhai-cover")
CATEGORIES = (
    "functionalCorrectness",
    "security",
    "performanceAndScalability",
    "codeQuality",
    "innovationAndUsefulness",
    "reproducibility",
)
CATEGORY_LABELS = {
    "functionalCorrectness": "Functional correctness",
    "security": "Security",
    "performanceAndScalability": "Performance and scalability",
    "codeQuality": "Code quality",
    "innovationAndUsefulness": "Innovation and usefulness",
    "reproducibility": "Reproducibility",
}


def _digest(seed, value):
    return hashlib.sha256(f"{seed}\0{value}".encode("utf-8")).digest()


def _int(seed, value, low, high):
    number = int.from_bytes(_digest(seed, value)[:8], "big")
    return low + number % (high - low + 1)


def _case_id(seed, challenge, name):
    suffix = hashlib.sha256(f"{seed}\0{challenge}\0{name}".encode("utf-8")).hexdigest()[:12]
    return f"{challenge}.{name}.{suffix}"


def _category_statuses():
    reasons = {
        "functionalCorrectness": "Fixtures contain trusted oracles only; no participant revision was run.",
        "security": "No participant artifact or approved challenge-specific security probe set was supplied.",
        "performanceAndScalability": "No participant artifact or organizer-approved workload budget was supplied.",
        "codeQuality": "Maintainability requires review of a participant revision.",
        "innovationAndUsefulness": "Usefulness and product judgment require a judge review.",
        "reproducibility": "The fixture artifact is deterministic; participant rerun evidence is absent.",
    }
    return {
        name: {
            "category": CATEGORY_LABELS[name],
            "status": "UNVERIFIED",
            "scope": "participant evaluation",
            "reason": reasons[name],
        }
        for name in CATEGORIES
    }


def _pricingpulse(seed):
    cases = []
    base_price = 80 + _int(seed, "pricing.base.price", 20, 120)
    base_quantity = 40 + _int(seed, "pricing.base.quantity", 10, 90)
    base_costs = base_price * base_quantity // 2
    base = {
        "price": base_price,
        "quantity": base_quantity,
        "total_costs": base_costs,
    }
    cases.append({
        "id": _case_id(seed, "pricingpulse", "revenue-profit-margin"),
        "purpose": "Known-answer revenue, profit, and margin arithmetic.",
        "organizerInputs": base,
        "expectedOutput": {
            "status": "OK",
            "revenue": base_price * base_quantity,
            "profit": base_price * base_quantity - base_costs,
            "margin_percent": 50.0,
        },
        "oracleEvidence": challenge_checks.pricing_arithmetic_checks(
            base,
            {"status": "OK", "revenue": base_price * base_quantity,
             "profit": base_price * base_quantity - base_costs, "margin_percent": 50.0},
        ),
        "sourceBasis": "PricingPulse brief §§2, 5, 7: revenue=price×quantity; profit=revenue−costs; margin is explicit.",
        "fixtureOnly": True,
    })

    discount = {
        "price": 120,
        "quantity": 100,
        "total_costs": 7200,
        "discount_rate": 0.2,
        "quantity_after_discount": 110,
        "total_costs_after_discount": 7800,
    }
    discounted_price = discount["price"] * (1 - discount["discount_rate"])
    post_revenue = discounted_price * discount["quantity_after_discount"]
    post_profit = post_revenue - discount["total_costs_after_discount"]
    observed = {
        "status": "OK",
        "revenue": discount["price"] * discount["quantity"],
        "profit": discount["price"] * discount["quantity"] - discount["total_costs"],
        "margin_percent": 40.0,
        "discounted_price": discounted_price,
        "revenue_after_discount": post_revenue,
        "profit_after_discount": post_profit,
        "margin_after_discount_percent": post_profit / post_revenue * 100,
    }
    cases.append({
        "id": _case_id(seed, "pricingpulse", "discount-known-answer"),
        "purpose": "Discount price, explicit post-discount demand/cost assumptions, and profit margin.",
        "organizerInputs": discount,
        "maxDiscountRate": 0.3,
        "expectedOutput": observed,
        "oracleEvidence": challenge_checks.pricing_arithmetic_checks(discount, observed, max_discount_rate=0.3),
        "sourceBasis": "PricingPulse brief §7: discounted price, post-discount revenue, and margin; post-discount quantity/cost are explicit fixture assumptions.",
        "fixtureOnly": True,
    })

    zero_revenue = {"price": 0, "quantity": 9, "total_costs": 0}
    zero_observed = {"status": "OK", "revenue": 0, "profit": 0, "margin_percent": None}
    cases.append({
        "id": _case_id(seed, "pricingpulse", "zero-revenue-boundary"),
        "purpose": "Safe zero-revenue margin handling.",
        "organizerInputs": zero_revenue,
        "expectedOutput": zero_observed,
        "oracleEvidence": challenge_checks.pricing_arithmetic_checks(zero_revenue, zero_observed),
        "sourceBasis": "PricingPulse brief §7: zero revenue must not divide by zero; represent unavailable margin explicitly.",
        "fixtureOnly": True,
    })

    invalid = {"price": 100, "quantity": 10, "total_costs": 500, "discount_rate": 1.2,
               "quantity_after_discount": 12, "total_costs_after_discount": 600}
    invalid_observed = {"status": "INVALID_INPUT"}
    cases.append({
        "id": _case_id(seed, "pricingpulse", "invalid-discount-boundary"),
        "purpose": "Reject a discount rate outside the organizer-configured interval.",
        "organizerInputs": invalid,
        "maxDiscountRate": 0.5,
        "expectedOutput": invalid_observed,
        "oracleEvidence": challenge_checks.pricing_arithmetic_checks(invalid, invalid_observed, max_discount_rate=0.5),
        "sourceBasis": "PricingPulse brief §7: negative or out-of-range discount rates require safe invalid-input handling.",
        "fixtureOnly": True,
    })

    cases.append({
        "id": _case_id(seed, "pricingpulse", "elasticity-unverified"),
        "purpose": "Reserve an elasticity scenario slot without inventing hidden demand truth or a finite-change convention.",
        "organizerInputs": None,
        "expectedOutput": None,
        "oracleEvidence": [{"id": "pricingpulse.elasticity_reference", "status": "UNVERIFIED",
                            "detail": "Hidden demand scenarios and the finite-change elasticity convention require organizer approval."}],
        "sourceBasis": "PricingPulse brief §§4, 14: reference scenarios and elasticity convention are unresolved organizer decisions.",
        "fixtureOnly": True,
    })
    return cases


def _synthetic_veera_catalog(seed):
    platforms = ("synthetic-a", "synthetic-b", "synthetic-c")
    catalog = {}
    portfolio = []
    labels = {}
    for index in range(15):
        creator_id = f"fixture-creator-{index + 1:02d}"
        catalog[creator_id] = {
            "price_per_post_inr": 12_000 + _int(seed, f"veera.price.{index}", 0, 68_000),
            "regional_language": index < 4,
        }
        portfolio.append({"creator_id": creator_id, "posts": 1 + _int(seed, f"veera.posts.{index}", 0, 2),
                          "platform": platforms[index % len(platforms)]})
        labels[creator_id] = False
    return portfolio, catalog, labels, set(platforms)


def _veera(seed):
    portfolio, catalog, labels, platforms = _synthetic_veera_catalog(seed)
    case_rows = [
        ("synthetic-valid-constraints", [row.copy() for row in portfolio], catalog.copy(), labels.copy(), platforms,
         "All generated records are synthetic; validates only deterministic hard constraints."),
    ]
    too_concentrated = [row.copy() for row in portfolio]
    for row in too_concentrated:
        row["platform"] = "synthetic-a"
    case_rows.append(("platform-concentration", too_concentrated, catalog.copy(), labels.copy(), platforms,
                      "Synthetic adversarial case: one platform receives all spend."))
    known_fake = labels.copy()
    known_fake[portfolio[0]["creator_id"]] = True
    case_rows.append(("known-adjudicated-fake", [row.copy() for row in portfolio], catalog.copy(), known_fake, platforms,
                      "Synthetic adversarial label only; not a real creator classification."))
    incomplete_labels = labels.copy()
    incomplete_labels.pop(portfolio[-1]["creator_id"])
    case_rows.append(("incomplete-organizer-labels", [row.copy() for row in portfolio], catalog.copy(), incomplete_labels, platforms,
                      "Partial synthetic labels must not be treated as a full fake-audience result."))

    cases = []
    for name, rows, creator_catalog, fake_labels, known_platforms, purpose in case_rows:
        evidence = challenge_checks.veera_portfolio_checks(
            {"creators": rows}, creator_catalog, fake_labels=fake_labels,
            known_platforms=known_platforms, creator_catalog_complete=True,
        )
        cases.append({
            "id": _case_id(seed, "veera-footwear", name),
            "purpose": purpose,
            "organizerInputs": {
                "portfolio": {"creators": rows},
                "syntheticCreatorCatalog": creator_catalog,
                "syntheticFakeLabels": fake_labels,
                "syntheticKnownPlatforms": sorted(known_platforms),
            },
            "oracleEvidence": evidence,
            "sourceBasis": "Borrowed Audiences brief §§2, 5, 7: 15 creators, 1–3 posts, ₹40 lakh budget, ≤50% platform spend, ≥3 regional creators, exclude adjudicated fakes.",
            "fixtureOnly": True,
        })
    cases.append({
        "id": _case_id(seed, "veera-footwear", "hidden-buyer-simulator-unverified"),
        "purpose": "Do not invent the missing unique-real-buyer simulator or its score normalization.",
        "organizerInputs": None,
        "oracleEvidence": [{"id": "veera.unique_real_buyers", "status": "UNVERIFIED",
                            "detail": "Canonical audience data, hidden simulator, scenarios, and approved normalization are not included."}],
        "sourceBasis": "Borrowed Audiences brief §§3, 7, 12: hidden simulator data and scoring decisions are unavailable.",
        "fixtureOnly": True,
    })
    return cases


def _mazhai(seed):
    actual = [80 + 7 * index + _int(seed, f"mazhai.actual.{index}", 0, 15) for index in range(8)]
    predicted = [value + (-1 if index % 2 else 1) * (2 + _int(seed, f"mazhai.error.{index}", 0, 8))
                 for index, value in enumerate(actual)]
    weights = [1 + _int(seed, f"mazhai.weight.{index}", 0, 4) for index in range(8)]
    metrics = {
        "weightedMapePercent": challenge_checks.weighted_mape(predicted, actual, weights, 1.0),
        "p99TailLogError": challenge_checks.p99_tail_log_error(132.0, 120.0),
        "lossRatioPenaltyFactor": challenge_checks.loss_ratio_penalty_factor(0.68),
    }
    return [{
        "id": _case_id(seed, "mazhai-cover", "synthetic-metric-oracles"),
        "purpose": "Exercise published weighted-MAPE, P99 log-error, and loss-ratio gate-factor formulas with synthetic values.",
        "organizerInputs": {
            "syntheticPredictedLoss": predicted,
            "syntheticActualLoss": actual,
            "syntheticRiderWeights": weights,
            "epsilon": 1.0,
            "syntheticPredictedP99": 132.0,
            "syntheticActualP99": 120.0,
            "syntheticLossRatio": 0.68,
        },
        "referenceMetrics": metrics,
        "oracleEvidence": [
            {"id": "mazhai.weighted_mape", "status": "AVAILABLE", "detail": "Formula oracle only; no hidden test labels or score conversion."},
            {"id": "mazhai.p99_tail_log_error", "status": "AVAILABLE", "detail": "Formula oracle only; proposed threshold calibration is not frozen."},
            {"id": "mazhai.loss_ratio_penalty_factor", "status": "AVAILABLE", "detail": "Published gate factor only; no mark cap is applied."},
        ],
        "sourceBasis": "Mazhai brief §§3–5, 13: rider-weighted MAPE, P99 tail error, and loss-ratio gate factor are formula primitives; thresholds need calibration.",
        "fixtureOnly": True,
    }, {
        "id": _case_id(seed, "mazhai-cover", "hidden-season-data-unverified"),
        "purpose": "Reserve robustness and extreme-season validation for organizer-supplied hidden data.",
        "organizerInputs": None,
        "referenceMetrics": None,
        "oracleEvidence": [{"id": "mazhai.hidden_seasonal_scenarios", "status": "UNVERIFIED",
                            "detail": "No canonical seasonal scenarios, labels, or calibrated thresholds are included."}],
        "sourceBasis": "Mazhai brief §§5, 13: hidden season/data-quality fixtures and score calibration require organizer input.",
        "fixtureOnly": True,
    }]


def generate_bundle(challenge="all", seed=SEED_DEFAULT):
    if challenge not in (*CHALLENGES, "all"):
        raise ValueError(f"unsupported challenge: {challenge}")
    selected = CHALLENGES if challenge == "all" else (challenge,)
    generators = {
        "pricingpulse": _pricingpulse,
        "veera-footwear": _veera,
        "mazhai-cover": _mazhai,
    }
    cases = []
    provenance = []
    for name in selected:
        cases.extend(generators[name](seed))
        if name == "pricingpulse":
            source = "repos/DoomBot_PricingPulse_Dynamic_Pricing_Evaluation_Metrics.docx"
            sections = ["§2 source-defined requirements", "§5 revenue/profit", "§7 discount arithmetic", "§14 organizer decisions"]
        elif name == "veera-footwear":
            source = "repos/DoomBot_Borrowed_Audiences_Evaluation_Metrics_Black_White.docx"
            sections = ["§2 source-defined constraints", "§3 unique real buyers", "§5 portfolio constraints", "§7 required inputs", "§12 organizer decisions"]
        else:
            source = "repos/DoomBot_Mazhai_Cover_Evaluation_Metric.docx"
            sections = ["§3 weighted-MAPE", "§4 financial outcomes", "§5 robustness", "§13 calibration decisions"]
        provenance.append({"challenge": name, "sourceBrief": source, "sections": sections,
                           "fixtureData": "Synthetic deterministic fixture values; not source data or canonical hidden labels."})
    canonical_cases = json.dumps(cases, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {
        "format": "doomforge.challenge-benchmark-fixtures",
        "schemaVersion": 1,
        "fixtureVersion": FIXTURE_VERSION,
        "seed": {"value": seed, "derivation": "SHA-256(seed || NUL || fixture-field), integer modulo range; no ambient randomness."},
        "provenance": provenance,
        "participantEvaluated": False,
        "officialScoring": False,
        "marks": None,
        "categoryStatuses": _category_statuses(),
        "fixtureIntegrity": {"algorithm": "sha256", "casesDigest": hashlib.sha256(canonical_cases.encode("utf-8")).hexdigest(),
                             "scope": "Exact generated cases only; does not prove participant result reproducibility."},
        "cases": cases,
        "limitations": [
            "No participant code was imported, executed, or evaluated.",
            "Synthetic fixture outputs are test oracles, never team marks.",
            "Subjective categories and missing organizer data remain UNVERIFIED.",
            "No containers, images, challenge repositories, or production scores are created or changed by this CLI.",
        ],
    }


def serialize_bundle(bundle, pretty=False):
    if pretty:
        return json.dumps(bundle, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    return json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--challenge", choices=("all", *CHALLENGES), default="all")
    parser.add_argument("--seed", default=SEED_DEFAULT)
    parser.add_argument("--output", type=Path, help="Write the local JSON artifact to this path; defaults to stdout.")
    parser.add_argument("--pretty", action="store_true", help="Indent JSON for inspection.")
    parser.add_argument("--verify-repeatability", action="store_true", help="Generate twice and require identical bytes before output.")
    args = parser.parse_args(argv)
    first = serialize_bundle(generate_bundle(args.challenge, args.seed), args.pretty)
    if args.verify_repeatability:
        second = serialize_bundle(generate_bundle(args.challenge, args.seed), args.pretty)
        if first != second:
            parser.error("fixture generation was not repeatable")
    if args.output:
        args.output.write_text(first, encoding="utf-8", newline="\n")
    else:
        print(first, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
