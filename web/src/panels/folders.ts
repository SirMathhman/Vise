// The folder picker: a dialog that browses the server's folders, so a new chat can be opened in one of them.

const folderDialog = document.getElementById("folder-dialog") as HTMLDialogElement;
const folderPath = document.getElementById("folder-path") as HTMLParagraphElement;
const folderUp = document.getElementById("folder-up") as HTMLButtonElement;
const folderList = document.getElementById("folder-list") as HTMLUListElement;
const folderStatus = document.getElementById("folder-status") as HTMLParagraphElement;
const folderOpen = document.getElementById("folder-open") as HTMLButtonElement;
const folderCancel = document.getElementById("folder-cancel") as HTMLButtonElement;

// One listing from the server: the folder shown, the folder above it ("" above the top level), and the folders in it.
interface FolderListing {
  path: string;
  parent: string;
  folders: { name: string; path: string }[];
}

// The folder the picker is showing, and the folder above it. An empty path is the top level, which has no folder to open.
let shownFolder = "";
let parentFolder = "";
// Called with the chosen folder when the user opens it.
let onFolderChosen: ((dir: string) => void) | null = null;

// Opens the picker at `start`, or at the server's startup folder when `start` is null. Opening a folder calls `onChosen`.
function openFolderPicker(start: string | null, onChosen: (dir: string) => void): void {
  onFolderChosen = onChosen;
  void browseFolder(start);
  folderDialog.showModal();
}

// Shows the folders in `path`. A null path asks the server for its startup folder.
async function browseFolder(path: string | null): Promise<void> {
  folderStatus.hidden = true;
  try {
    const listing = await postJson<FolderListing>("/api/dirs", path === null ? {} : { path });
    shownFolder = listing.path;
    parentFolder = listing.parent;
    folderPath.textContent = listing.path === "" ? "Top level" : listing.path;
    folderUp.disabled = listing.path === "";
    folderOpen.disabled = listing.path === "";
    folderList.replaceChildren(
      ...listing.folders.map((folder) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = folder.name;
        button.addEventListener("click", () => void browseFolder(folder.path));
        item.append(button);
        return item;
      }),
    );
  } catch (err) {
    showStatus(folderStatus, errorMessage(err), true);
  }
}

folderUp.addEventListener("click", () => void browseFolder(parentFolder));

folderOpen.addEventListener("click", () => {
  const chosen = onFolderChosen;
  folderDialog.close();
  if (chosen !== null && shownFolder !== "") {
    chosen(shownFolder);
  }
});

folderCancel.addEventListener("click", () => folderDialog.close());
