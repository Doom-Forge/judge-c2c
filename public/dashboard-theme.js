(() => {
	const root = document.documentElement;
	const storageKey = "doomforge-theme";
	const saved = localStorage.getItem(storageKey);
	const initial = saved === "light" || saved === "dark"
		? saved
		: matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";

	root.dataset.theme = initial;

	const updateControl = () => {
		const control = document.getElementById("theme-toggle");
		if (!control) return;
		const next = root.dataset.theme === "dark" ? "light" : "dark";
		control.textContent = `${next[0].toUpperCase()}${next.slice(1)} theme`;
		control.setAttribute("aria-label", `Switch to ${next} theme`);
	};

	document.addEventListener("click", (event) => {
		const control = event.target.closest("#theme-toggle");
		if (!control) return;
		root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
		localStorage.setItem(storageKey, root.dataset.theme);
		updateControl();
	});

	document.addEventListener("DOMContentLoaded", updateControl, {
		once: true,
	});
})();
