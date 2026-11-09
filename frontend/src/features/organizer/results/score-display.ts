export function displayedStageScore(score: number | null): string {
	return score === null ? "Pending" : score.toFixed(1);
}

export function calculateDisplayedFinalScore(
	analysis: number | null,
	engineering: number | null,
): number | null {
	return analysis === null || engineering === null
		? null
		: Number(((analysis * 10 + engineering * 90) / 100).toFixed(1));
}

export type ResultTransition = "freeze" | "unfreeze" | "publish" | "unpublish";

export function transitionConfirmation(
	_action: ResultTransition,
	reason: string,
): boolean {
	return reason.trim().length >= 10;
}
