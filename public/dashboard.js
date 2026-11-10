(() => {
	const tabList = document.querySelector('[role="tablist"]');
	const tabs = [...tabList.querySelectorAll('[role="tab"]')];
	const panels = new Map(tabs.map((tab) => [
		tab,
		document.getElementById(tab.getAttribute("aria-controls")),
	]));

	function selectTab(selected, focus = false) {
		for (const tab of tabs) {
			const active = tab === selected;
			tab.setAttribute("aria-selected", String(active));
			tab.tabIndex = active ? 0 : -1;
			tab.classList.toggle("is-active", active);
			panels.get(tab).hidden = !active;
		}
		if (focus) selected.focus();
	}

	for (const tab of tabs) {
		tab.addEventListener("click", () => selectTab(tab));
		tab.addEventListener("keydown", (event) => {
			const index = tabs.indexOf(tab);
			const next = event.key === "ArrowRight"
				? (index + 1) % tabs.length
				: event.key === "ArrowLeft"
				? (index - 1 + tabs.length) % tabs.length
				: event.key === "Home"
				? 0
				: event.key === "End"
				? tabs.length - 1
				: -1;
			if (next < 0) return;
			event.preventDefault();
			selectTab(tabs[next], true);
		});
	}

	const fileInput = document.getElementById("analysis-file");
	const fileStatus = document.getElementById("analysis-file-status");
	fileInput.addEventListener("change", () => {
		const file = fileInput.files[0];
		if (!file) {
			fileStatus.textContent =
				"Local preview only; a selected file is not uploaded or stored.";
			return;
		}
		if (!/\.(pdf|docx)$/i.test(file.name)) {
			fileInput.value = "";
			fileStatus.textContent = "Choose a PDF or DOCX document.";
			return;
		}
		if (file.size > 2 * 1024 * 1024) {
			fileInput.value = "";
			fileStatus.textContent = "File is larger than the 2 MB limit.";
			return;
		}
		fileStatus.textContent =
			`${file.name} selected. Local preview only; not uploaded.`;
	});

	const status = document.getElementById("service-status");
	fetch("/api/organization/status", {
		headers: { accept: "application/json" },
	})
		.then(async (response) => {
			if (response.status === 503) {
				status.textContent =
					"Local organization service is not configured; live role data is not shown.";
				return;
			}
			if (!response.ok) throw new Error("SERVICE_UNAVAILABLE");
			const result = await response.json();
			status.textContent = result.authenticated
				? "Authenticated workspace connected; available role access is determined by your account."
				: "Sign in to load the workspace available to your account.";
		})
		.catch(() => {
			status.textContent =
				"Role data is unavailable. Open the secure workspace to retry.";
		});
})();
