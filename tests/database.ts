import { readFileSync } from "node:fs";
export const migrationFiles = [
	"0001_foundation.sql",
	"0004_organization.sql",
	"0005_assignment_contract.sql",
	"0006_execution.sql",
	"0007_team_issue_workflow.sql",
	"0008_console_roles.sql",
	"0009_publication_recovery.sql",
	"0010_reviewer_capacity.sql",
	"0011_execution_cache.sql",
	"0012_artifact_store.sql",
	"0013_additional_contributions.sql",
	"0014_operational_telemetry.sql",
	"0015_submission_relations.sql",
	"0016_repository_context_indexes.sql",
	"0017_run_measurements.sql",
	"0018_confidential_security.sql",
	"0019_stacked_submission_relations.sql",
	"0020_runner_measurements.sql",
	"0021_console_identities.sql",
	"0022_stage_measurements.sql",
	"0023_dependency_audit_cache.sql",
	"0024_organization_retirement.sql",
	"0025_actions_runner.sql",
	"0026_actions_queue_deadlines.sql",
	"0027_matrix_judging.sql",
	"0032_round_two_documents.sql",
	"0033_round_two_judge_assignments.sql",
	"0034_round_two_reviews.sql",
	"0035_round_two_repository_rubrics.sql",
	"0036_matrix_team_attribution.sql",
	"0037_round_two_result_publication.sql",
	"0038_team_email.sql",
	"0039_team_lead_email.sql",
	"0040_team_onboarding.sql",
	"0041_round_two_result_freeze.sql",
	"0042_hackathon_deadlines.sql",
	"0043_round_two_announcements.sql",
	"0044_email_only_team_members.sql",
	"0045_participant_email_login.sql",
	"0046_round_two_review_score_sharing.sql",
	"0047_final_team_onboarding.sql",
	"0048_unverified_matrix_intake.sql",
	"0049_round_two_team_final_scores.sql",
] as const;
export async function migrate(
	db: D1Database,
	files: readonly string[] = migrationFiles,
) {
	for (const file of files) {
		const source = readFileSync("migrations/" + file, "utf8"),
			triggers = source.match(/CREATE TRIGGER[\s\S]*?END;/g) ?? [];
		const sql = source.replace(/CREATE TRIGGER[\s\S]*?END;/g, "");
		const statements = sql
			.split(";")
			.map((s) => s.trim())
			.filter(Boolean);
		// One ordered transaction per migration avoids exhausting local HTTP ports
		// when several real D1 fixture databases are initialized concurrently.
		await db.batch(
			[...statements, ...triggers].map((sql) => db.prepare(sql)),
		);
	}
}
