import { fetchProfiles, saveProfile, deleteProfile } from "./api.js";
import { setupKeyboardMenu } from "./menu.js";

/**
 * Wires up the "Profiles" dropdown in the chat header: a selector for the
 * user-defined instruction profile that gets injected into the LLM context as
 * a system message for the conversations that select it (the "custom agent"
 * persona), plus an in-app editor to create and delete profiles.
 *
 * A profile is a named block of instructions stored on the backend (like the
 * notes store). The "No instructions" option is a virtual default that sends
 * no profile system message (the pre-profile behavior); it is never stored.
 *
 * The module-level `selectedName` / `selectedInstructions` pair is the
 * profile the active conversation is currently using. The chat behavior module
 * freezes this into the per-conversation working set on the conversation's
 * first send (exactly like the notes snapshot) and re-sends it with every
 * request; it calls `setSelectedProfile()` when switching conversations so
 * the dropdown button label and highlight reflect the restored choice.
 *
 * Owns its own DOM, fetch, and open/close state; reads no conversation state.
 * @param {HTMLElement} appEl - The app root element.
 */

let selectedName = ""; // "" = the virtual "No instructions" default
let selectedInstructions = "";

// The dropdown button's label element, captured by setupProfiles so the
// exported `setSelectedProfile` can keep the button in sync when the chat
// module restores a conversation's frozen profile choice.
let profileLabel = null;

const updateProfileBtn = () => {
  if (profileLabel) {
    profileLabel.textContent =
      selectedName === "" ? "No instructions" : selectedName;
  }
};

export function setupProfiles(appEl) {
  const profileBtn = appEl.querySelector("#chat-profile-btn");
  profileLabel = profileBtn.querySelector(".chat-profile-title");
  const profileList = appEl.querySelector("#chat-profile-list");

  // Shared keyboard-menu contract (menu.js): items carry role="menuitem" +
  // tabindex="-1"; the menu handles arrow/Home/End navigation and calls
  // `activate` on Enter/Space. Activation reuses each item's click handler
  // (which selects the profile), so keyboard and mouse behave identically.
  const profileMenu = setupKeyboardMenu({
    listEl: profileList,
    activate: (li) => li.click(),
  });

  const openProfileDropdown = async () => {
    profileBtn.setAttribute("aria-expanded", "true");
    profileList.hidden = false;
    try {
      const profiles = await fetchProfiles();
      renderProfileList(profiles);
    } catch {
      renderProfileList([]);
    }
    profileMenu.open();
  };

  const closeProfileDropdown = () => {
    profileList.hidden = true;
    profileBtn.setAttribute("aria-expanded", "false");
  };

  const refresh = async () => {
    let profiles;
    try {
      profiles = await fetchProfiles();
    } catch {
      return; // keep the current list on a failed re-fetch
    }
    renderProfileList(profiles);
  };

  const renderProfileList = (profiles) => {
    profileList.replaceChildren();
    profileList.appendChild(createNoInstructionsItem());
    profileList.appendChild(createDivider());
    if (profiles.length === 0) {
      profileList.appendChild(createEmptyHint());
    }
    for (const profile of profiles) {
      profileList.appendChild(createProfileItem(profile));
    }
    profileList.appendChild(createDivider());
    profileList.appendChild(createEditorForm());
  };

  const createNoInstructionsItem = () => {
    const li = document.createElement("li");
    li.className = "chat-profile-item chat-profile-item-default";
    li.dataset.name = "";
    li.setAttribute("role", "menuitem");
    li.setAttribute("tabindex", "-1");
    li.textContent = "No instructions";
    if (selectedName === "") li.classList.add("chat-dropdown-active");
    li.addEventListener("click", () => {
      selectedName = "";
      selectedInstructions = "";
      updateProfileBtn();
      closeProfileDropdown();
    });
    return li;
  };

  const createDivider = () => {
    const hr = document.createElement("li");
    hr.className = "chat-profile-divider";
    hr.setAttribute("role", "separator");
    return hr;
  };

  const createEmptyHint = () => {
    const p = document.createElement("li");
    p.className = "chat-profile-empty";
    p.textContent = "No profiles yet — create one below.";
    return p;
  };

  const createProfileItem = (profile) => {
    const li = document.createElement("li");
    li.className = "chat-profile-item";
    li.dataset.name = profile.name;
    li.setAttribute("role", "menuitem");
    li.setAttribute("tabindex", "-1");
    li.title = profile.instructions || "(no instructions)";
    if (selectedName === profile.name) {
      li.classList.add("chat-dropdown-active");
    }

    const label = document.createElement("span");
    label.className = "chat-dropdown-item-title";
    label.textContent = profile.name;
    li.appendChild(label);

    const del = document.createElement("button");
    del.className = "chat-dropdown-delete";
    del.type = "button";
    del.textContent = "\u00d7";
    del.setAttribute("aria-label", `Delete profile ${profile.name}`);
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await deleteProfile(profile.name);
        await refresh();
      } catch {
        // Ignore; the list keeps the stale entry so the user can retry.
      }
    });
    li.appendChild(del);

    li.addEventListener("click", () => {
      selectedName = profile.name;
      selectedInstructions = profile.instructions;
      updateProfileBtn();
      closeProfileDropdown();
    });
    return li;
  };

  const createEditorForm = () => {
    const form = document.createElement("li");
    form.className = "chat-profile-editor";
    form.setAttribute("role", "group");
    form.setAttribute("aria-label", "Create a profile");

    const heading = document.createElement("span");
    heading.className = "chat-profile-editor-heading";
    heading.textContent = "New profile";
    form.appendChild(heading);

    const nameInput = document.createElement("input");
    nameInput.className = "chat-profile-name";
    nameInput.type = "text";
    nameInput.placeholder = "Profile name";
    nameInput.setAttribute("aria-label", "Profile name");

    const textArea = document.createElement("textarea");
    textArea.className = "chat-profile-instructions";
    textArea.rows = 4;
    textArea.placeholder = "Instructions to inject as a system message…";
    textArea.setAttribute("aria-label", "Profile instructions");

    const save = document.createElement("button");
    save.className = "chat-profile-save";
    save.type = "button";
    save.textContent = "Save profile";
    save.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      const instructions = textArea.value;
      if (name === "") return;
      try {
        await saveProfile(name, instructions);
        nameInput.value = "";
        textArea.value = "";
        await refresh();
      } catch {
        // Ignore; the form keeps its values so the user can retry.
      }
    });

    form.append(nameInput, textArea, save);
    return form;
  };

  profileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (profileList.hidden) openProfileDropdown();
    else closeProfileDropdown();
  });

  // Close on outside click or Escape.
  document.addEventListener("click", (e) => {
    if (profileList.hidden) return;
    if (e.target.closest(".chat-profile-dropdown")) return;
    closeProfileDropdown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !profileList.hidden) {
      closeProfileDropdown();
      profileBtn.focus();
    }
  });

  updateProfileBtn();
}

/**
 * Return the name of the profile the active conversation is using. `""` is
 * the virtual "No instructions" default (no profile system message sent).
 * @returns {string}
 */
export function getSelectedProfileName() {
  return selectedName;
}

/**
 * Return the instructions for the profile the active conversation is using.
 * Returns `""` for the "No instructions" default and for a profile whose
 * instructions are empty — in both cases the caller skips the profile system
 * message.
 * @returns {string}
 */
export function getSelectedProfileInstructions() {
  return selectedInstructions;
}

/**
 * Re-sync the UI's selected profile to the given name and instructions.
 * Called by the chat module after restoring (or starting) a conversation so
 * the dropdown button label and the active-item highlight reflect that
 * conversation's frozen choice. An empty name selects the "No instructions"
 * default.
 * @param {string} name
 * @param {string} instructions
 */
export function setSelectedProfile(name, instructions) {
  selectedName = name ?? "";
  selectedInstructions = instructions ?? "";
  updateProfileBtn();
}
