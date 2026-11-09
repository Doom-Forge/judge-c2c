"""Trusted deterministic primitives for challenge briefs.

These functions consume JSON-like values only. They never import or execute a
participant module, and they report evidence states without assigning marks.
"""

from collections.abc import Mapping, Sequence, Set
import math

PASS = "PASS"
FAIL = "FAIL"
UNVERIFIED = "UNVERIFIED"


def _finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _check(check_id, status, measured, limit, detail):
    return {
        "id": check_id,
        "status": status,
        "measured": measured,
        "limit": limit,
        "detail": detail,
    }


def _portfolio_rows(submission):
    if not isinstance(submission, Mapping):
        return None
    rows = submission.get("creators")
    if not isinstance(rows, list):
        return None
    if any(not isinstance(row, Mapping) for row in rows):
        return None
    return rows


def veera_portfolio_checks(
    submission,
    canonical_creators=None,
    *,
    fake_labels=None,
    known_platforms=None,
    creator_catalog_complete=False,
):
    """Validate Veera hard constraints from organizer-supplied canonical data.

    ``canonical_creators`` maps creator IDs to records containing
    ``price_per_post_inr`` and ``regional_language``. ``fake_labels`` maps IDs
    to adjudicated booleans. ``None`` means that source is unavailable. A
    non-None but partial mapping remains unverified for uncovered IDs.
    """
    rows = _portfolio_rows(submission)
    if rows is None:
        return [
            _check("veera.portfolio", UNVERIFIED, None, None,
                   "No usable portfolio was supplied to the trusted validator.")
        ]

    creator_ids = [row.get("creator_id") for row in rows]
    ids_are_strings = all(isinstance(value, str) and value for value in creator_ids)
    unique_ids = set(creator_ids) if ids_are_strings else set()
    unique_count = len(unique_ids)
    checks = [
        _check(
            "veera.unique_creators",
            PASS if ids_are_strings and len(rows) == 15 and unique_count == 15 else FAIL,
            unique_count if ids_are_strings else None,
            {"rows": 15, "unique_ids": 15},
            "Requires exactly 15 portfolio rows with 15 distinct creator IDs.",
        )
    ]

    catalog = canonical_creators if isinstance(canonical_creators, Mapping) else None
    known_status = UNVERIFIED
    if catalog is not None:
        if all(creator_id in catalog for creator_id in unique_ids):
            known_status = PASS
        elif creator_catalog_complete:
            known_status = FAIL
    checks.append(_check(
        "veera.known_creators", known_status,
        len([creator_id for creator_id in unique_ids if catalog is not None and creator_id in catalog]),
        unique_count,
        "Checked IDs against the organizer creator catalog; an incomplete catalog cannot establish unknown IDs.",
    ))

    valid_posts = all(
        type(row.get("posts")) is int and 1 <= row["posts"] <= 3
        for row in rows
    )
    checks.append(_check(
        "veera.post_counts", PASS if valid_posts else FAIL,
        [row.get("posts") for row in rows], "integer 1–3 per selected creator",
        "Post allocations must be integers from one through three.",
    ))

    valid_platform_values = all(isinstance(row.get("platform"), str) and row["platform"] for row in rows)
    platforms = known_platforms if isinstance(known_platforms, Set) else None
    platform_names_valid = valid_platform_values and platforms is not None and all(row["platform"] in platforms for row in rows)
    if platforms is None:
        platform_status = UNVERIFIED
        platform_detail = "The organizer platform catalog is unavailable."
    else:
        platform_status = PASS if platform_names_valid else FAIL
        platform_detail = "Checked each selected platform against the organizer platform catalog."
    checks.append(_check("veera.known_platforms", platform_status,
                         [row.get("platform") for row in rows],
                         sorted(platforms) if platforms is not None else None,
                         platform_detail))

    prices = {}
    price_inputs_complete = catalog is not None and valid_posts and ids_are_strings
    if price_inputs_complete:
        for creator_id in unique_ids:
            record = catalog.get(creator_id)
            if not isinstance(record, Mapping) or not _finite_number(record.get("price_per_post_inr")) or record["price_per_post_inr"] < 0:
                price_inputs_complete = False
                break
            prices[creator_id] = record["price_per_post_inr"]
    spends = []
    if price_inputs_complete:
        spends = [prices[row["creator_id"]] * row["posts"] for row in rows]
        total_spend = sum(spends)
        spend_is_finite = math.isfinite(total_spend) and all(math.isfinite(spend) for spend in spends)
        budget_status = PASS if spend_is_finite and total_spend <= 4_000_000 else FAIL
        checks.append(_check("veera.budget", budget_status, total_spend if spend_is_finite else "non-finite",
                             4_000_000,
                             "Spend uses canonical organizer price per post and submitted post counts."))
    else:
        total_spend = None
        checks.append(_check("veera.budget", UNVERIFIED, None, 4_000_000,
                             "Canonical price or valid post-count data is missing."))

    if (total_spend is None or not math.isfinite(total_spend) or
            not all(math.isfinite(spend) for spend in spends) or
            not valid_platform_values or platforms is None or not platform_names_valid):
        checks.append(_check("veera.platform_spend_share", UNVERIFIED, None, 0.5,
                             "Canonical spend or a validated platform catalog is missing."))
    elif total_spend <= 0:
        checks.append(_check("veera.platform_spend_share", UNVERIFIED, {}, 0.5,
                             "Platform spend share is undefined when total spend is zero."))
    else:
        spend_by_platform = {}
        for row, spend in zip(rows, spends):
            spend_by_platform[row["platform"]] = spend_by_platform.get(row["platform"], 0) + spend
        shares = {name: amount / total_spend for name, amount in sorted(spend_by_platform.items())}
        checks.append(_check("veera.platform_spend_share",
                             PASS if all(share <= 0.5 for share in shares.values()) else FAIL,
                             shares, 0.5,
                             "Each platform's share is based on canonical spend."))

    regional_values = []
    regional_complete = catalog is not None and ids_are_strings
    if regional_complete:
        for creator_id in unique_ids:
            record = catalog.get(creator_id)
            if not isinstance(record, Mapping) or type(record.get("regional_language")) is not bool:
                regional_complete = False
            else:
                regional_values.append((creator_id, record["regional_language"]))
    regional_count = sum(flag for _, flag in regional_values)
    if regional_count >= 3:
        regional_status = PASS
    elif regional_complete:
        regional_status = FAIL
    else:
        regional_status = UNVERIFIED
    checks.append(_check("veera.regional_creators", regional_status,
                         regional_count, 3,
                         "Counted only organizer-classified regional-language creators."))

    labels = fake_labels if isinstance(fake_labels, Mapping) else None
    if labels is None or not ids_are_strings:
        fake_status = UNVERIFIED
        fake_detail = "Adjudicated fake-audience labels are unavailable."
    else:
        selected_labels = [labels.get(creator_id) for creator_id in unique_ids]
        known_fake = any(value is True for value in selected_labels)
        missing_labels = any(type(value) is not bool for value in selected_labels)
        fake_status = FAIL if known_fake else UNVERIFIED if missing_labels else PASS
        fake_detail = "Checked submitted IDs against organizer-adjudicated fake-audience labels."
    checks.append(_check("veera.exclude_known_fake", fake_status, None,
                         "no selected creator labelled fake", fake_detail))
    return checks


PRICING_FIELDS = (
    ("revenue", "revenue"),
    ("profit", "profit"),
    ("margin_percent", "margin_percent"),
    ("discounted_price", "discounted_price"),
    ("revenue_after_discount", "revenue_after_discount"),
    ("profit_after_discount", "profit_after_discount"),
    ("margin_after_discount_percent", "margin_after_discount_percent"),
)


def _input_error(inputs, max_discount_rate):
    required = ("price", "quantity", "total_costs")
    for key in required:
        if key not in inputs:
            return f"missing:{key}"
        value = inputs[key]
        if not _finite_number(value) or value < 0:
            return f"{key} must be a finite non-negative number"
    discount_keys = ("discount_rate", "quantity_after_discount", "total_costs_after_discount")
    supplied = [key in inputs for key in discount_keys]
    if "discount_rate" in inputs:
        rate = inputs["discount_rate"]
        if not _finite_number(rate) or rate < 0 or rate > 1 or (max_discount_rate is not None and rate > max_discount_rate):
            return "discount rate is outside the organizer-configured range"
    if all(supplied):
        for key in discount_keys[1:]:
            if not _finite_number(inputs[key]) or inputs[key] < 0:
                return f"{key} must be a finite non-negative number"
    return None


def pricing_arithmetic_checks(inputs, observed, *, max_discount_rate=None):
    """Compare reported PricingPulse arithmetic against supplied scenario data.

    A missing discount demand/cost assumption leaves discounted calculations
    UNVERIFIED. This function does not invent elasticity, costs, or scores.
    """
    if not isinstance(inputs, Mapping):
        return [_check("pricingpulse.inputs", UNVERIFIED, None, None,
                       "Supplied scenario inputs are unavailable.")]
    if max_discount_rate is not None and (not _finite_number(max_discount_rate) or not 0 <= max_discount_rate <= 1):
        raise ValueError("max_discount_rate must be a finite value from zero to one")
    if not isinstance(observed, Mapping):
        observed = {}

    error = _input_error(inputs, max_discount_rate)
    if error:
        if error.startswith("missing:"):
            return [_check("pricingpulse.inputs", UNVERIFIED, None, None,
                           "The organizer-supplied arithmetic scenario is incomplete.")]
        rejected = observed.get("status") == "INVALID_INPUT" or observed.get("errorCode") == "INVALID_INPUT"
        return [_check("pricingpulse.invalid_input_handling", PASS if rejected else FAIL,
                       "rejected" if rejected else "not rejected", "explicit INVALID_INPUT response", error)]

    revenue = inputs["price"] * inputs["quantity"]
    profit = revenue - inputs["total_costs"]
    has_discount_case = all(key in inputs for key in ("discount_rate", "quantity_after_discount", "total_costs_after_discount"))
    discounted_values = None
    if has_discount_case:
        discounted_price = inputs["price"] * (1 - inputs["discount_rate"])
        discount_revenue = discounted_price * inputs["quantity_after_discount"]
        discount_profit = discount_revenue - inputs["total_costs_after_discount"]
        discounted_values = (discounted_price, discount_revenue, discount_profit)
    calculations = (revenue, profit) + (discounted_values or ())
    if not all(math.isfinite(value) for value in calculations):
        rejected = observed.get("status") == "INVALID_INPUT" or observed.get("errorCode") == "INVALID_INPUT"
        return [_check("pricingpulse.invalid_input_handling", PASS if rejected else FAIL,
                       "rejected" if rejected else "non-finite arithmetic", "explicit INVALID_INPUT response",
                       "Finite supplied values overflowed during independent calculation." )]
    base_margin = None if revenue == 0 else profit / revenue * 100
    discount_margin = None
    if discounted_values is not None and discounted_values[1] != 0:
        discount_margin = discounted_values[2] / discounted_values[1] * 100
    margin_values = [value for value in (base_margin, discount_margin) if value is not None]
    if not all(math.isfinite(value) for value in margin_values):
        rejected = observed.get("status") == "INVALID_INPUT" or observed.get("errorCode") == "INVALID_INPUT"
        return [_check("pricingpulse.invalid_input_handling", PASS if rejected else FAIL,
                       "rejected" if rejected else "non-finite margin", "explicit INVALID_INPUT response",
                       "Finite supplied values overflowed during independent margin calculation.")]
    expected = {
        "revenue": revenue,
        "profit": profit,
        "margin_percent": base_margin,
    }
    if has_discount_case:
        discounted_price, discount_revenue, discount_profit = discounted_values
        expected.update({
            "discounted_price": discounted_price,
            "revenue_after_discount": discount_revenue,
            "profit_after_discount": discount_profit,
            "margin_after_discount_percent": discount_margin,
        })

    if observed.get("status", "OK") != "OK":
        return [_check("pricingpulse.output_status", FAIL, observed.get("status"), "OK",
                       "A valid arithmetic case must return an OK result.")]

    checks = []
    for check_id, key in PRICING_FIELDS:
        if key not in expected:
            checks.append(_check(f"pricingpulse.{check_id}", UNVERIFIED, None, None,
                                 "The brief requires organizer-supplied post-discount demand and cost assumptions."))
            continue
        actual = observed.get(key)
        target = expected[key]
        if target is None:
            valid = key in observed and actual is None
        else:
            valid = _finite_number(actual) and math.isclose(target, actual, rel_tol=1e-9, abs_tol=1e-9)
        checks.append(_check(f"pricingpulse.{check_id}", PASS if valid else FAIL,
                             actual if key in observed else None, target,
                             "Compared to an independent formula using the supplied scenario."))
    if has_discount_case:
        if max_discount_rate is None:
            checks.append(_check("pricingpulse.discount_rate_range", UNVERIFIED,
                                 inputs["discount_rate"], None,
                                 "The organizer-configured maximum discount rate is unavailable."))
        else:
            checks.append(_check("pricingpulse.discount_rate_range", PASS,
                                 inputs["discount_rate"], max_discount_rate,
                                 "The rate is within the organizer-configured discount range."))
    return checks


def weighted_mape(predicted, actual, rider_weights, epsilon):
    """Mazhai published rider-weighted MAPE metric, without score mapping."""
    if not all(isinstance(values, Sequence) and not isinstance(values, (str, bytes))
               for values in (predicted, actual, rider_weights)):
        raise ValueError("prediction, actual, and weight arrays are required")
    if not predicted or len(predicted) != len(actual) or len(actual) != len(rider_weights):
        raise ValueError("arrays must have the same non-zero length")
    if not _finite_number(epsilon) or epsilon <= 0:
        raise ValueError("epsilon must be a finite positive number")
    if not all(_finite_number(value) for group in (predicted, actual, rider_weights) for value in group):
        raise ValueError("all metric inputs must be finite numbers")
    if any(weight < 0 for weight in rider_weights) or sum(rider_weights) <= 0:
        raise ValueError("rider weights must be non-negative with a positive total")
    result = sum(weight * abs(pred - truth) / max(abs(truth), epsilon)
                 for pred, truth, weight in zip(predicted, actual, rider_weights)) / sum(rider_weights) * 100
    if not math.isfinite(result):
        raise ValueError("metric result is not finite")
    return result


def p99_tail_log_error(predicted_p99, actual_p99):
    """Mazhai published tail-error metric, without score mapping."""
    if not _finite_number(predicted_p99) or not _finite_number(actual_p99) or predicted_p99 <= 0 or actual_p99 <= 0:
        raise ValueError("P99 values must be finite and positive")
    return abs(math.log(predicted_p99) - math.log(actual_p99))


def loss_ratio_penalty_factor(loss_ratio):
    """Return the brief's B1 gate factor without applying a B1 mark cap."""
    if not _finite_number(loss_ratio) or loss_ratio < 0:
        raise ValueError("loss ratio must be finite and non-negative")
    return max(0.0, 1.0 - 4.0 * (loss_ratio - 0.65)) if loss_ratio > 0.65 else 1.0
