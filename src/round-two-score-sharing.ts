type ReviewSource = {
	teamId?: unknown;
	stage?: unknown;
	judgeIdentityId?: unknown;
	reviewId?: unknown;
};

type SnapshotWithReviewSources = {
	reviewSources?: ReviewSource[];
};

function reviewSourceId(
	snapshot: string,
	teamId: string,
	stage: string,
	judgeIdentityId: string,
): string | null {
	try {
		const parsed = JSON.parse(snapshot) as SnapshotWithReviewSources;
		const source = parsed.reviewSources?.find((item) =>
			item.teamId === teamId && item.stage === stage &&
			item.judgeIdentityId === judgeIdentityId &&
			typeof item.reviewId === "string"
		);
		return typeof source?.reviewId === "string" ? source.reviewId : null;
	} catch {
		return null;
	}
}

export async function publishedReviewId(
	db: D1Database,
	teamId: string,
	stage: string,
	judgeIdentityId: string,
): Promise<string | null> {
	const row = await db
		.prepare(
			"SELECT s.snapshot FROM round_two_result_publication p JOIN round_two_result_snapshots s ON s.id=p.snapshot_id WHERE p.id=1 AND p.snapshot_id IS NOT NULL AND p.published_at IS NOT NULL",
		)
		.first<{ snapshot: string }>();
	return row
		? reviewSourceId(row.snapshot, teamId, stage, judgeIdentityId)
		: null;
}

export async function participantSharedScores(
	db: D1Database,
	teamId: string,
	snapshotId: string,
) {
	const scores = await db
		.prepare(
			"SELECT s.stage,s.score,share.shared_at AS sharedAt FROM round_two_review_score_shares share JOIN round_two_review_submissions s ON s.id=share.submission_id JOIN round_two_result_snapshots snapshot ON snapshot.id=? WHERE share.team_id=? AND share.revoked_at IS NULL AND EXISTS(SELECT 1 FROM json_each(snapshot.snapshot,'$.reviewSources') source WHERE json_extract(source.value,'$.teamId')=share.team_id AND json_extract(source.value,'$.stage')=s.stage AND json_extract(source.value,'$.judgeIdentityId')=share.judge_identity_id AND json_extract(source.value,'$.reviewId')=s.id) ORDER BY share.shared_at DESC,share.submission_id LIMIT 500",
		)
		.bind(snapshotId, teamId)
		.all<{ stage: string; score: number; sharedAt: string }>();
	return scores.results;
}
