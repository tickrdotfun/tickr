"use client";

import { useCallback, useRef, useState } from "react";
import {useAccount, useGasPrice } from "wagmi";
import { DEMO } from "@/lib/demoTransport";
import { formatEther } from "viem";
import { ipfsUriFor } from "@/lib/cid";
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

/**
 * Images picked but not yet sent anywhere, by the `ipfs://` name their bytes already have. Nothing leaves the
 * browser while someone is filling the form; `uploadPickedImage` sends the bytes once the coin is on chain.
 */
const held = new Map<string, { blob: Blob; filename: string }>();

/** Sends the bytes behind an `ipfs://` link a launch has just written on chain. Quiet about failure: the link is
 *  already in the coin, and a retry can follow from anywhere that holds the same file. */
export async function uploadPickedImage(uri: string | undefined): Promise<boolean> {
  if (!uri) return false;
  const item = held.get(uri);
  if (!item) return false;
  // the link is already written into the coin and cannot be changed, so this tries harder than a single request
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const fd = new FormData();
      fd.append("file", item.blob, item.filename);
      const r = await fetch("/api/pin", { method: "POST", body: fd });
      if (!r.ok) continue;
      const out = (await r.json().catch(() => ({}))) as { image?: string };
      // the service names the bytes the same way this page did; anything else means they did not survive the trip
      if (out.image && out.image !== uri) return false;
      held.delete(uri);
      return true;
    } catch {
      // try again
    }
  }
  return false;
}

/** Whether this deployment can pin at all. Asked before a file is read, so an image can go on-chain instead when
 *  the answer is no, rather than pointing a launched coin at a link nothing will ever serve. */
async function pinningWorks(): Promise<boolean> {
  try {
    const r = await fetch("/api/pin");
    if (!r.ok) return false;
    return ((await r.json()) as { pinning?: boolean }).pinning === true;
  } catch {
    return false;
  }
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
        // first choice: an ipfs link, so the coin carries a short name instead of the bytes. the name comes from
        // the bytes themselves, so nothing is uploaded here; the file is sent once the launch is on chain
        if (await pinningWorks()) {
          const blob = await forPin(file);
          const link = await ipfsUriFor(await blob.arrayBuffer());
          held.set(link, { blob, filename: file.name.replace(/\.[^.]+$/, "") + (blob.type === "image/webp" ? ".webp" : "") });
          onChange(link);
          setBytes(undefined);
          return;
        }
        // nowhere to upload to: the image goes into the coin itself
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
    [onChange],
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
      <div className="label label-muted mb-1.5">Image, optional</div>
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
              {busy ? "uploading…" : value ? "replace" : "pick an image"}
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
