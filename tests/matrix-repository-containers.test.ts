import { expect, it } from "vitest";

it("exports distinct container classes for the four competition repositories", async () => {
	const workflow: unknown = await import("../src/matrix-workflow");
	const classes = workflow as Record<string, unknown>,
		image = "registry.cloudflare.com/test/image@sha256:" + "1".repeat(64),
		repositories = [
			["MazhaiCoverMatrixRunner", "mazhai-cover"],
			["PricingPulseMatrixRunner", "pricingpulse"],
			["VeeraFootwearMatrixRunner", "veera-footwear"],
			["JanusMatrixRunner", "janus"],
		] as const;
	const starts: string[] = [];

	for (const [name, repository] of repositories) {
		const Runner = classes[name] as new (
			state: unknown,
			env: unknown,
		) => { evaluate(raw: unknown): Promise<unknown> };
		const container = {
			images: { base: image },
			start: () => starts.push(name),
		};
		const runner = new Runner(
			{ container },
			{ MATRIX_IMAGE_URI: image },
		);
		await expect(
			runner.evaluate({ repository, image, files: [] }),
		).rejects.toThrow("MATRIX_SPECIFICATION_REQUIRED");
	}
	expect(starts).toHaveLength(0);
});
