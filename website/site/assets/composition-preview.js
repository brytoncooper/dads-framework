/* global document, window */
const preview = document.querySelector(".composition-preview");

if (preview) {
  const tabList = preview.querySelector(".composition-tabs");
  const tabs = [...tabList.querySelectorAll('[role="tab"]')];
  const access = preview.querySelector("#composition-access");
  const response = preview.querySelector("#composition-status");
  const detail = preview.querySelector("#composition-detail");
  const cases = {
    member: {
      status: "200 OK",
      detail: "The tenant member can list notes.",
      outcome: "allowed",
    },
    revoked: {
      status: "404 Not Found",
      detail: "The account has lost access to this workspace.",
      outcome: "missing",
    },
    staff: {
      status: "404 Not Found",
      detail: "The staff API does not mount the notes route.",
      outcome: "missing",
    },
  };
  let activeTab = tabs[0];

  function updateResponse() {
    const example =
      activeTab.id === "composition-tab-staff"
        ? cases.staff
        : cases[access.value];
    response.textContent = example.status;
    response.dataset.outcome = example.outcome;
    detail.textContent = example.detail;
  }

  function selectTab(selected) {
    activeTab = selected;
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      panel.hidden = !active;
    }
    updateResponse();
  }

  for (const tab of tabs) {
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    tab.addEventListener("click", () => selectTab(tab));
  }

  tabList.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    let target;
    switch (event.key) {
      case "ArrowLeft":
        target = tabs[(index - 1 + tabs.length) % tabs.length];
        break;
      case "ArrowRight":
        target = tabs[(index + 1) % tabs.length];
        break;
      case "Home":
        target = tabs[0];
        break;
      case "End":
        target = tabs.at(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
    selectTab(target);
    target.focus();
  });
  access.addEventListener("change", updateResponse);
  window.addEventListener("pageshow", updateResponse);

  selectTab(activeTab);
  preview.querySelector("#preview-cases").hidden = true;
  preview.querySelector(".composition-controls").hidden = false;
  tabList.hidden = false;
  preview.classList.add("composition-enhanced");
}
