export function displayedStageScore(score: number | null): string {
	return score === null ? "Pending" : score.toFixed(1);
}

export type ResultTransition = "freeze" | "unfreeze" | "publish" | "unpublish";

export function transitionConfirmation(
	_action: ResultTransition,
	reason: string,
): boolean {
	return reason.trim().length >= 10;
}
