/** A picture waiting to go with the next message. */
export interface Attached {
  uri: string;
  label: string;
}

/** Most pictures that may come with one message (the server enforces the same limit). */
const MAX_ATTACHED = 6;
const MAX_BYTES = 10_000_000;
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface Attachments {
  /** The pictures chosen so far, handed over once (the next message takes them). */
  take(): Attached[];
  count(): number;
}

function read(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Pictures for the next message: pasted into the message box, dropped on the
 * composer, or picked with the attach button. Each shows as a small
 * removable thumbnail above the box until the message is sent.
 */
export function createAttachments(parts: {
  input: HTMLElement;
  dropZone: HTMLElement;
  list: HTMLElement;
  button: HTMLButtonElement;
  picker: HTMLInputElement;
  /** Told when something is refused (wrong type, too big, too many). */
  say: (message: string) => void;
}): Attachments {
  const { input, dropZone, list, button, picker, say } = parts;
  let items: Attached[] = [];

  const render = (): void => {
    list.textContent = "";
    list.classList.toggle("hidden", items.length === 0);
    items.forEach((item, index) => {
      const chip = document.createElement("span");
      chip.className = "attachment";
      const image = document.createElement("img");
      image.src = item.uri;
      image.alt = item.label;
      image.title = item.label;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = `remove ${item.label}`;
      remove.addEventListener("click", () => {
        items = items.filter((_, i) => i !== index);
        render();
      });
      chip.append(image, remove);
      list.append(chip);
    });
  };

  const add = async (files: File[]): Promise<void> => {
    for (const file of files) {
      if (!TYPES.includes(file.type)) {
        say(
          `${file.name || "that file"} is not a png, jpeg, gif or webp image`,
        );
      } else if (file.size > MAX_BYTES) {
        say(`${file.name || "that image"} is larger than 10 MB`);
      } else if (items.length >= MAX_ATTACHED) {
        say(`at most ${MAX_ATTACHED} images can go with one message`);
      } else {
        items.push({
          uri: await read(file),
          label: file.name || "pasted image",
        });
      }
    }
    render();
  };

  input.addEventListener("paste", (event) => {
    const files = Array.from(
      (event as ClipboardEvent).clipboardData?.files ?? [],
    );
    if (files.some((f) => f.type.startsWith("image/"))) {
      event.preventDefault();
      void add(files);
    }
  });
  dropZone.addEventListener("dragover", (event) => event.preventDefault());
  dropZone.addEventListener("drop", (event) => {
    const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void add(files);
  });
  button.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    void add(Array.from(picker.files ?? []));
    picker.value = "";
  });

  return {
    take() {
      const taken = items;
      items = [];
      render();
      return taken;
    },
    count: () => items.length,
  };
}
