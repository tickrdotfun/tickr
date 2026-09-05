import { SwatchBar, TickrMark } from "@/components/Mark";
import { Backdrop } from "@/components/art/Backdrop";

/**
 * The listing artwork: a token icon and a profile header, for capture.
 *
 * Built to the constraints the venues actually impose rather than to what looks good large:
 *
 *   - wallets crop the icon to a circle, so the artwork IS a circle and the corners are transparent
 *   - it has to hold on a white row and a near-black one, so it carries its own opaque ground and a thin
 *     signal ring to keep its edge off a dark background
 *   - it is read at 16 to 32px in a token list, so it is the `t` and the tittle, which is the lockup the
 *     brand already specifies below 24px, and not the five-letter wordmark
 *   - the header is 3:1, which is what DEX Screener and the rest take
 */

export default function TokenArt() {
  return (
    <div className="tk">
      <style
        dangerouslySetInnerHTML={{
          __html: [
            `.tk{background:transparent;padding:0;margin:0}`,

            /* ---- the icon, authored at 512 and exported down.
               A flat swatch yellow face with the letter in ink and the tittle in swatch red. Colour sits
               behind the letter as one field rather than across it, which is the only arrangement that
               survives a 16px row: anything patterned under the `t` dissolves at that size. */
            `.tk-icon{position:relative;width:512px;height:512px;border-radius:50%;display:grid;place-items:center;` +
              `background:var(--tickr-sw-yellow)}`,
            /* The t and its tittle move as one group. The nudge is measured, not guessed: the ink of the
               pair sat 25px right and 11px above the circle's centre at 512, because the tittle is off to
               one side and the t's own hand-set tilt leans it. Scaled up so the mark fills about two
               thirds of the circle, which is what survives a 16px row. */
            `.tk-lock{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) translate(-41px,17px)}`,
            `.tk-t{display:block;font-family:var(--font-serif);font-weight:600;font-size:390px;line-height:1;` +
              `color:#0B1710;transform:rotate(-2.5deg)}`,
            `.tk-dot{position:absolute;left:74%;top:6%;width:112px;height:112px;border-radius:50%;background:var(--tickr-sw-red)}`,

            // ---- the 3:1 profile header
            `.tk-head{position:relative;width:1500px;height:500px;background:var(--bg);overflow:hidden;` +
              `display:flex;flex-direction:column;align-items:center;justify-content:center}`,
            `.tk-head-tag{margin-top:32px;font-size:30px;color:var(--muted);font-weight:500}`,
            // the lockup's tittle floats outside its layout box, so the group reads high when centred
            `.tk-head-mid{display:flex;flex-direction:column;align-items:center;transform:translateY(26px)}`,
            /* The backdrop is a fixed, full-viewport SVG on 1440x900. Here it is pinned inside the banner
               at that same ratio and clipped, so the constellations keep their proportions instead of being
               squashed into 3:1, and we see the middle band of the sky. */
            `.tk-sky{position:absolute;inset:0;overflow:hidden;pointer-events:none}`,
            `.tk-head .backdrop-art{position:absolute;left:0;top:50%;width:1500px;height:938px;` +
              `transform:translateY(-50%);opacity:0.3}`,
            `.tk-head-sw{position:absolute;left:0;right:0;bottom:0;width:100%!important;height:14px;border-radius:0}`,
          ].join(""),
        }}
      />

      <div className="tk-icon">
        <span className="tk-lock">
          <span className="tk-t">t</span>
          <span className="tk-dot" />
        </span>
      </div>

      <div className="tk-head">
        {/* the site's own sky, cropped to the banner rather than restyled into a different drawing */}
        <span className="tk-sky">
          <Backdrop />
        </span>
        <div className="tk-head-mid">
          <TickrMark size={118} />
          <div className="tk-head-tag">
            pair anything on <span className="cap">Robinhood Chain</span>.
          </div>
        </div>
        <SwatchBar className="tk-head-sw" />
      </div>
    </div>
  );
}
