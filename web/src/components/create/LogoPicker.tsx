"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, useChainId, useGasPrice, useSignMessage } from "wagmi";
import { DEMO } from "@/lib/demoTransport";
import { UPLOAD_AUTH_TTL_MS, encodeUploadAuth, uploadMessage } from "@/lib/uploadAuth";
import { formatEther } from "viem";
import { resolveImage } from "@/lib/imageSrc";

/**
 * The coin image. First choice is a pin through tickr's server (`/api/pin`), which leaves a short link in the
 * token's `logo` string. Where pinning is not set up, or refused for the moment, the image itself is written
 * into that string on-chain, where it costs about 710 gas per byte and lives as long as the token does.
 *
 * A file that goes on-chain is therefore squeezed to a small square before it goes anywhere near a
 * transaction: drawn to a 64px canvas and encoded as WebP, dropping quality (then size) until it fits the
 * target. A link can still be pasted instead, which stores only the URL.
 */
const CANVAS_SIZES = [64, 56, 48] as const;
const QUALITIES = [0.85, 0.7, 0.55, 0.4] as const;
const TARGET_BYTES = 3 * 1024;
const MAX_BYTES = 6 * 1024;
/** Measured on the launch path: a byte of `logo` costs ~710 gas end to end. */
const GAS_PER_BYTE = 710;

function encode(img: HTMLImageElement, size: number, quality: number, type: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  // cover: fill the square from the middle of the image, so nothing is letterboxed
  const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL(type, quality);
}

async function shrink(file: File): Promise<{ uri: string; bytes: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("that file could not be read as an image."));
      el.src = url;
    });
    // WebP is much smaller for photographs; browsers that will not produce it fall back to PNG.
    const probe = encode(img, 16, 0.8, "image/webp");
    const type = probe.startsWith("data:image/webp") ? "image/webp" : "image/png";
    let best = "";
    for (const size of CANVAS_SIZES) {
      for (const q of QUALITIES) {
        const uri = encode(img, size, q, type);
        if (!uri) throw new Error("this browser could not process the image.");
        best = uri;
        if (uri.length <= TARGET_BYTES) return { uri, bytes: uri.length };
      }
    }
    return { uri: best, bytes: best.length };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A ≤512px WebP of the image for pinning: small enough to load anywhere, large enough to look like something. */
async function forPin(file: File): Promise<Blob> {
  if (file.type === "image/gif") return file; // keep the animation
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("that file could not be read as an image."));
      el.src = url;
    });
    const size = Math.min(512, Math.max(img.naturalWidth, img.naturalHeight));
    const uri = encode(img, size, 0.86, "image/webp");
    if (!uri.startsWith("data:image/webp")) return file;
    return await (await fetch(uri)).blob();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Pins through tickr's server; `undefined` means the image goes on-chain instead, whatever the reason. */
async function pinToIpfs(file: File, auth: string | undefined): Promise<string | undefined> {
  const blob = await forPin(file);
  const fd = new FormData();
  fd.append("file", blob, file.name.replace(/\.[^.]+$/, "") + (blob.type === "image/webp" ? ".webp" : ""));
  const r = await fetch("/api/pin", { method: "POST", body: fd, headers: auth ? { "x-upload-auth": auth } : undefined });
  // 401: no signed-in wallet. 429: over the upload budget. 503: pinning is not set up here. 5xx: it failed. in every
  // case the image goes on-chain instead, quietly, so a launch is never held up by the pinning service
  if (r.status === 401 || r.status === 429 || r.status === 503 || r.status >= 500) return undefined;
  const out = (await r.json().catch(() => ({}))) as { image?: string; error?: string };
  if (!r.ok) throw new Error(out.error ?? "pinning failed");
  return out.image;
}

export function LogoPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [bytes, setBytes] = useState<number | undefined>();
  const [linking, setLinking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const gasPrice = useGasPrice();
  const { address } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();

  // the permission to upload: one free signature per wallet per hour, kept for this tab. no wallet, or a declined
  // signature, means no permission, and the image goes on-chain instead
  const uploadAuth = useCallback(async (): Promise<string | undefined> => {
    if (DEMO || !address) return undefined;
    const key = `tickr.upload.${chainId}.${address.toLowerCase()}`;
    try {
      const kept = sessionStorage.getItem(key);
      if (kept) {
        const a = JSON.parse(atob(kept)) as { until?: number };
        if (typeof a.until === "number" && a.until > Date.now() + 60_000) return kept;
      }
    } catch {
      // nothing kept
    }
    const until = Date.now() + UPLOAD_AUTH_TTL_MS;
    try {
      const signature = await signMessageAsync({ message: uploadMessage(address, chainId, until) });
      const enc = encodeUploadAuth({ address, until, signature });
      try {
        sessionStorage.setItem(key, enc);
      } catch {
        // a tab without storage signs again next time
      }
      return enc;
    } catch {
      return undefined;
    }
  }, [address, chainId, signMessageAsync]);

  const take = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError("pick an image file.");
        return;
      }
      if (file.size > 4 * 1024 * 1024) {
        setError("up to 4 MB.");
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        // first choice: pin to IPFS through tickr's server, so the token carries a short link instead of the bytes.
        // off the preview that takes a signed-in wallet; without one the image is stored with the coin
        const pinned = DEMO || address ? await pinToIpfs(file, await uploadAuth()) : undefined;
        if (pinned) {
          onChange(pinned);
          setBytes(undefined);
          return;
        }
        const { uri, bytes: n } = await shrink(file);
        if (n > MAX_BYTES) {
          setError("that image is too detailed to store on-chain. try a simpler one, like a logo on a flat background.");
          return;
        }
        onChange(uri);
        setBytes(n);
      } catch (e) {
        setError(e instanceof Error ? e.message : "that image could not be read.");
      } finally {
        setBusy(false);
      }
    },
    [onChange, address, uploadAuth],
  );

  // an image pasted while the image area has focus becomes the coin image. nowhere else on the page listens,
  // so a screenshot pasted into a text field, or by accident, is never uploaded.
  const onZonePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return; // the link field inside the zone takes text
    const f = Array.from(e.clipboardData?.files ?? []).find((x) => x.type.startsWith("image/"));
    if (!f) return;
    e.preventDefault();
    void take(f);
  };

  const isData = value.startsWith("data:");
  const isIpfs = value.startsWith("ipfs://");
  const addedGas = bytes ? BigInt(bytes) * BigInt(GAS_PER_BYTE) : 0n;
  const addedWei = gasPrice.data && addedGas ? addedGas * gasPrice.data : undefined;
  const cost = addedWei !== undefined ? `${Number(formatEther(addedWei)).toFixed(4)} eth` : `${(Number(addedGas) / 1e6).toFixed(2)}m gas`;

  return (
    <div>
      <div className="label label-muted mb-1.5">Image</div>
      <div
        className={`logo-drop ${dragging ? "is-dragging" : ""}`}
        tabIndex={0}
        onPaste={onZonePaste}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void take(e.dataTransfer.files?.[0]);
        }}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={resolveImage(value)} alt="" className="logo-preview" />
        ) : (
          <span className="logo-preview logo-preview-empty" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mr-1.5 -mt-px inline-block align-middle">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <circle cx="9" cy="10" r="1.6" />
                <path d="M21 16l-5-5-8 8" />
              </svg>
              {busy ? "pinning…" : value ? "replace" : "pick an image"}
            </button>
            {value && (
              <button
                type="button"
                className="text-[13px] text-muted hover:text-white"
                onClick={() => {
                  onChange("");
                  setBytes(undefined);
                  setError(undefined);
                }}
              >
                remove
              </button>
            )}
            {!value && !linking && (
              <button type="button" className="text-[13px] text-muted hover:text-white" onClick={() => setLinking(true)}>
                or paste a link
              </button>
            )}
          </div>
          <p className="text-[13px] text-dim mt-2">
            {/* where the image ends up is our problem, not the creator's. only say what changes what they do. */}
            {isIpfs
              ? "uploaded. it stays with the coin forever."
              : isData && bytes
                ? `stored with the coin, ${(bytes / 1024).toFixed(1)} kb. adds about ${cost} to your launch.`
                : isData && !address && !DEMO
                  ? "stored with the coin. connect a wallet and pick it again to upload it instead."
                  : isData
                    ? "stored with the coin."
                  : "png, jpg, gif or webp. click here, then Ctrl+V to paste one."}
          </p>
          {linking && !isData && (
            <input
              className="mt-3"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="https://…/logo.png"
              aria-label="Image link"
            />
          )}
          {error && <p className="text-[13px] text-danger mt-2">{error}</p>}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          void take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
