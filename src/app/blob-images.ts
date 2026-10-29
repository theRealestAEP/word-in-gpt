// The host CSP allows data: images but not blob: images, and wordinweb shows
// document pictures as blob: URLs. When a blob: image fails to load, show a
// data: URL of the same bytes instead.
const blobs = new Map<string, Blob>();
const { createObjectURL, revokeObjectURL } = URL;

URL.createObjectURL = (object) => {
  const url = createObjectURL.call(URL, object);
  if (object instanceof Blob) blobs.set(url, object);
  return url;
};
URL.revokeObjectURL = (url) => {
  blobs.delete(url);
  revokeObjectURL.call(URL, url);
};

// An image error does not bubble, so listen in the capture phase.
document.addEventListener("error", ({ target }) => {
  const blob = target instanceof HTMLImageElement ? blobs.get(target.src) : undefined;
  if (!blob) return;
  const reader = new FileReader();
  reader.onload = () => { (target as HTMLImageElement).src = reader.result as string; };
  reader.readAsDataURL(blob);
}, true);
