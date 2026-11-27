/* ==========================================================
   Droplet 3 : Découpe de façade
   Photo d'un bâtiment → planche « référence + découpe + légende ».
   1. La photo (réduite) part à l'analyse, qui renvoie une description chiffrée (JSON).
      Sans clé, on part d'un modèle à remplir soi-même.
   2. Le dessin (1080 × 1350) et la planche (2310 × 2360) sont faits ici, sur l'appareil.
   3. Contrôles automatiques + cases à cocher avant validation.
   ========================================================== */
"use strict";
(() => {
  const CLE_API = "phant_cle_anthropic"; // hors du préfixe des sauvegardes : la clé ne part jamais dans un export
  const MODELE = "claude-haiku-5-5"; // le moins coûteux qui lit les images (0,10 $ / 0,50 $ par million de jetons)

  /* Code couleur : une même forme garde toujours la même couleur */
  const C = {
    fond: "#2B2B30", silhouette: "#141417", planche: "#161618",
    corniche: "#FF2E93", panneau: "#B81E69", console: "#A259FF",
    matiere: "#3DFF6E", bandeau: "#8C8C96",
    linteau: "#FF3B30", cadre: "#F4F4F4", vantail: "#FFE11A", vitre: "#33384D", allume: "#FFF6B0", appui: "#CFCFD6",
    rideau: "#FF9F1C", clim: "#9AA3AE",
    enseigne: "#FF8A00", store: "#FF6B6B", store2: "#FFFFFF", pilastre: "#2F7BFF",
    vitrine: "#1E3A8A", porte: "#B97A3D", recit: "#00F0FF"
  };
  const ZONES = [
    ["corniche", "A · Corniche"], ["console", "A · Consoles"], ["panneau", "A · Panneaux"],
    ["matiere", "B · Matière (aplat)"], ["bandeau", "B · Bandeaux"],
    ["linteau", "Fenêtre · Linteau"], ["cadre", "Fenêtre · Cadre"], ["vantail", "Fenêtre · Vantaux"], ["allume", "Fenêtre allumée"],
    ["enseigne", "C · Enseigne"], ["store", "C · Store"], ["pilastre", "C · Pilastres"], ["vitrine", "C · Vitrines"], ["porte", "C · Porte"],
    ["recit", "Récit (étals, mobilier)"]
  ];

  /* Modèle de départ (façade Ken Hing) : sert d'exemple à l'analyse et de base sans clé */
  const MODELE_JSON = {
    nom: "Ken Hing Food Market",
    ratio: 1.9,
    couronnement: { part: 0.1, consoles: 8, panneaux: 7 },
    etages: { niveaux: 2, colonnes: 3, matiere: "briques", allumees: [[2, 0], [0, 1]], variantes: { clim: [[0, 0]], rideaux: [] } },
    rez_de_chaussee: { part: 0.4, enseigne: "KEN HING FOOD MARKET", store: { bandes: 13 }, vitrines: 2, porte: "centre", pilastres: 2, etals: [4, 5] },
    supprime: ["mur latéral + graffitis", "perspective", "tirants du store", "usure"],
    ecarts: []
  };

  const CONSIGNE = `Tu analyses la photo d'un bâtiment pour une illustration de façade (collection PHANT).
Règles :
1. Isole la façade principale (celle qui porte l'entrée et l'enseigne) ; ignore faces latérales, voisins, trottoir.
2. Redresse-la mentalement en vue de face : estime ratio = hauteur / largeur de la façade, et le nombre d'étages au-dessus du rez-de-chaussée.
3. Découpe en 3 blocs : A couronnement (corniche, consoles, ornements), B étages (matière, grille de fenêtres, bandeaux), C rez-de-chaussée (enseigne, store, vitrines, porte, pilastres). "part" = part de la hauteur totale occupée par A et par C (entre 0 et 1).
4. Grille de fenêtres : colonnes × niveaux, même entraxe.
5. Compte les éléments répétés : consoles, panneaux du couronnement, bandes du store (festons), vitrines, pilastres, caisses des étals (une valeur par étal ; [] s'il n'y en a pas). store.bandes = 0 s'il n'y a pas de store.
6. Variantes visibles : clim et rideaux, en positions [colonne, niveau] (colonne 0 = gauche, niveau 0 = le plus haut).
7. Fenêtres allumées : 30 à 50 % du total, en damier, jamais deux sur la même ligne ni la même colonne, positions [colonne, niveau].
8. "supprime" : ce qu'on retire (usure, graffitis, câbles, tirants, affichettes, perspective…). On garde ce qui fait l'identité.
9. Simplifie vers la symétrie (porte : "centre", "gauche" ou "droite") ; chaque écart volontaire avec la photo va dans "ecarts".
Réponds uniquement par un objet JSON, sans texte autour, exactement de cette forme (exemple pour une épicerie en briques) :
${JSON.stringify(MODELE_JSON)}`;

  /* ---------- Analyse (étapes 2–3) ---------- */
  async function photoEnBase64(img) {
    const e = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight)); // image réduite = moins de jetons
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * e); c.height = Math.round(img.naturalHeight * e);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  }

  async function analyser(img, cle) {
    const rep = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cle,
        "anthropic-version": "2026-10-21",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: MODELE,
        max_tokens: 2000,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await photoEnBase64(img) } },
          { type: "text", text: CONSIGNE }
        ] }]
      })
    });
    const r = await rep.json().catch(() => ({}));
    if (!rep.ok) throw new Error(r?.error?.message || `Erreur ${rep.status}`);
    if (r.stop_reason === "refusal") throw new Error("L'analyse a été refusée pour cette photo.");
    const texte = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const debut = texte.indexOf("{"), fin = texte.lastIndexOf("}");
    if (debut < 0 || fin < debut) throw new Error("Réponse illisible, remplis la description à la main.");
    return JSON.parse(texte.slice(debut, fin + 1));
  }

  /* ---------- Mise en place des mesures (description → pixels) ---------- */
  const nb = (v, def, min = 0) => Number.isFinite(+v) ? Math.max(min, Math.round(+v)) : def;
  const paires = v => Array.isArray(v) ? v.filter(p => Array.isArray(p) && p.length === 2).map(p => p.map(Number)) : [];

  function normaliser(d) {
    const A = d.couronnement || {}, B = d.etages || {}, R = d.rez_de_chaussee || {};
    return {
      nom: String(d.nom || "Façade"),
      ratio: Math.min(4, Math.max(0.4, +d.ratio || 1.5)),
      A: { part: Math.min(0.3, Math.max(0.03, +A.part || 0.1)), consoles: nb(A.consoles, 0), panneaux: nb(A.panneaux, 0) },
      B: {
        niveaux: nb(B.niveaux, 2, 1), colonnes: nb(B.colonnes, 3, 1), matiere: String(B.matiere || ""),
        allumees: paires(B.allumees), clim: paires(B.variantes?.clim), rideaux: paires(B.variantes?.rideaux)
      },
      C: {
        part: Math.min(0.5, Math.max(0.1, +R.part || 0.3)), enseigne: String(R.enseigne || d.nom || ""),
        bandes: nb(R.store?.bandes, 0), vitrines: nb(R.vitrines, 2), porte: ["gauche", "droite"].includes(R.porte) ? R.porte : "centre",
        pilastres: nb(R.pilastres, 2), etals: Array.isArray(R.etals) ? R.etals.map(n => nb(n, 0)).filter(n => n > 0) : []
      },
      supprime: Array.isArray(d.supprime) ? d.supprime.map(String) : [],
      ecarts: Array.isArray(d.ecarts) ? d.ecarts.map(String) : []
    };
  }

  function mesures(d) {
    const W = Math.min(720, 1060 / d.ratio), H = W * d.ratio; // place gardée à droite pour les repères A/B/C
    const x0 = (1080 - W) / 2, haut = (1350 - H) / 2;
    const yA = haut + d.A.part * H, yC = haut + H - d.C.part * H;
    const rowH = (yC - yA) / d.B.niveaux, colW = W / d.B.colonnes;
    const ww = Math.min(colW * 0.5, rowH * 0.48), wh = rowH * 0.6;
    return { W, H, x0, x1: x0 + W, haut, sol: haut + H, yA, yC, rowH, colW, ww, wh };
  }

  /* ---------- Dessin de la découpe (étape 4) ---------- */
  const rect = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };

  function fenetre(ctx, cx, y, w, h, v) {
    if (v.allumee) { ctx.save(); ctx.shadowColor = C.allume; ctx.shadowBlur = 28; rect(ctx, cx - w / 2, y, w, h, C.allume); ctx.restore(); }
    rect(ctx, cx - w / 2 - 7, y - 13, w + 14, 13, C.linteau);
    rect(ctx, cx - w / 2, y, w, h, C.cadre);
    const m = 5, vw = (w - 3 * m) / 2;
    for (let k = 0; k < 2; k++) {
      const vx = cx - w / 2 + m + k * (vw + m);
      rect(ctx, vx, y + m, vw, h - 2 * m, C.vantail);
      rect(ctx, vx + 3, y + m + 3, vw - 6, h - 2 * m - 6, v.allumee ? C.allume : C.vitre);
      rect(ctx, vx, y + h * 0.45, vw, 3, C.vantail); // petit bois
    }
    if (v.rideaux) {
      ctx.fillStyle = C.rideau;
      for (const s of [-1, 1]) {
        const bx = cx + s * (w / 2 - m - 3);
        ctx.beginPath(); ctx.moveTo(bx, y + m + 3); ctx.lineTo(bx - s * w * 0.22, y + m + 3); ctx.lineTo(bx, y + h * 0.7); ctx.fill();
      }
    }
    if (v.clim) {
      const bw = vw * 0.9, bh = h * 0.22, bx = cx - w / 2 + m + 2, by = y + h - m - bh - 3;
      rect(ctx, bx, by, bw, bh, C.clim);
      ctx.fillStyle = "rgba(0,0,0,.35)";
      for (let g = by + 4; g < by + bh - 2; g += 4) ctx.fillRect(bx + 4, g, bw - 8, 1.5);
    }
    rect(ctx, cx - w / 2 - 9, y + h, w + 18, 9, C.appui);
  }

  function dessiner(d) {
    const M = mesures(d), { W, x0, x1, haut, sol, yA, yC } = M;
    const cv = document.createElement("canvas");
    cv.width = 1080; cv.height = 1350;
    const ctx = cv.getContext("2d");
    rect(ctx, 0, 0, 1080, 1350, C.fond);
    rect(ctx, x0 - 8, haut - 8, W + 16, sol - haut + 8, C.silhouette);

    // A – couronnement
    const hA = yA - haut, hCor = hA * 0.3;
    rect(ctx, x0 - 10, haut, W + 20, hCor, C.corniche);
    const lp = W / Math.max(1, d.A.panneaux);
    for (let k = 0; k < d.A.panneaux; k++) {
      ctx.strokeStyle = C.panneau; ctx.lineWidth = 4;
      ctx.strokeRect(x0 + k * lp + 8, haut + hCor + 8, lp - 16, hA - hCor - 16);
    }
    const lc = Math.min(30, W / Math.max(1, d.A.consoles) * 0.5);
    for (let k = 0; k < d.A.consoles; k++) {
      const cx = d.A.consoles === 1 ? x0 + W / 2 : x0 + lc / 2 + k * (W - lc) / (d.A.consoles - 1);
      rect(ctx, cx - lc / 2, haut + hCor, lc, 8, C.console);                                 // tête
      rect(ctx, cx - lc / 4, haut + hCor + 8, lc / 2, (hA - hCor) * 0.6, C.console);          // corps
      ctx.fillStyle = C.console; ctx.beginPath();                                             // goutte
      ctx.arc(cx, haut + hCor + 8 + (hA - hCor) * 0.6, lc / 4, 0, Math.PI); ctx.fill();
    }

    // B – étages
    rect(ctx, x0, yA, W, yC - yA, C.matiere);
    const mat = d.B.matiere.toLowerCase();
    if (/brique|pierre/.test(mat)) {
      const pas = /pierre/.test(mat) ? 34 : 14, joint = pas * 2.2;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, yA, W, yC - yA); ctx.clip();
      ctx.fillStyle = "rgba(0,0,0,.16)";
      for (let y = yA, r = 0; y < yC; y += pas, r++) {
        ctx.fillRect(x0, y, W, 1.5);
        for (let x = x0 + (r % 2 ? joint / 2 : 0); x < x1; x += joint) ctx.fillRect(x, y, 1.5, pas);
      }
      ctx.restore();
    }
    for (let n = 1; n < d.B.niveaux; n++) rect(ctx, x0 - 4, yA + n * M.rowH - 5, W + 8, 10, C.bandeau);
    const a = (liste, c, n) => liste.some(([pc, pn]) => pc === c && pn === n);
    for (let n = 0; n < d.B.niveaux; n++) for (let c = 0; c < d.B.colonnes; c++) {
      fenetre(ctx, x0 + M.colW * (c + 0.5), yA + n * M.rowH + M.rowH * 0.22, M.ww, M.wh,
        { allumee: a(d.B.allumees, c, n), clim: a(d.B.clim, c, n), rideaux: a(d.B.rideaux, c, n) });
    }

    // C – rez-de-chaussée
    const hC = sol - yC, hE = hC * 0.2, hS = d.C.bandes ? hC * 0.16 : 0;
    rect(ctx, x0, yC, W, hE, C.enseigne);
    ctx.fillStyle = C.silhouette; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `800 ${Math.round(hE * 0.5)}px Changa, sans-serif`;
    ctx.fillText(d.C.enseigne.toUpperCase(), x0 + W / 2, yC + hE / 2, W - 30);
    const yS = yC + hE;
    if (d.C.bandes) { // store qui déborde volontairement
      const sx = x0 - 18, sw = W + 36, lb = sw / d.C.bandes;
      for (let k = 0; k < d.C.bandes; k++) {
        ctx.fillStyle = k % 2 ? C.store2 : C.store;
        ctx.fillRect(sx + k * lb, yS, lb + 0.5, hS);
        ctx.beginPath(); ctx.arc(sx + (k + 0.5) * lb, yS + hS, lb / 2, 0, Math.PI); ctx.fill(); // feston
      }
    }
    const yB = yS + hS + (d.C.bandes ? 14 : 0), hB = sol - yB;
    const lpil = 24, npil = d.C.pilastres;
    const pils = [...Array(npil)].map((_, k) => npil === 1 ? x0 : x0 + k * (W - lpil) / (npil - 1));
    pils.forEach(px => rect(ctx, px, yS + hS, lpil, sol - yS - hS, C.pilastre));
    const g = npil ? x0 + lpil + 12 : x0 + 12, dr = npil ? x1 - lpil - 12 : x1 - 12;
    const items = Array(d.C.vitrines).fill("v");
    const ip = d.C.porte === "gauche" ? 0 : d.C.porte === "droite" ? items.length : Math.ceil(items.length / 2);
    items.splice(ip, 0, "p");
    const poids = items.reduce((s, t) => s + (t === "p" ? 0.6 : 1), 0), ecart = 12;
    const unite = (dr - g - ecart * (items.length - 1)) / poids;
    let x = g, vitrinesX = [];
    for (const t of items) {
      const w = unite * (t === "p" ? 0.6 : 1);
      if (t === "p") {
        rect(ctx, x, yB, w, hB, C.porte);
        rect(ctx, x + w * 0.15, yB + hB * 0.1, w * 0.7, hB * 0.4, C.vitre);
        ctx.fillStyle = C.cadre; ctx.beginPath(); ctx.arc(x + w * 0.8, yB + hB * 0.6, 4, 0, Math.PI * 2); ctx.fill();
      } else {
        rect(ctx, x, yB, w, hB * 0.85, C.cadre);
        rect(ctx, x + 5, yB + 5, w - 10, hB * 0.85 - 10, C.vitrine);
        rect(ctx, x + w / 2 - 2, yB, 4, hB * 0.85, C.cadre); // meneau
        const grad = ctx.createLinearGradient(0, yB + 10, 0, yB + hB * 0.6); // spot
        grad.addColorStop(0, "rgba(255,246,176,.55)"); grad.addColorStop(1, "rgba(255,246,176,0)");
        ctx.fillStyle = grad; ctx.beginPath();
        ctx.moveTo(x + w * 0.25, yB + 10); ctx.lineTo(x + w * 0.1, yB + hB * 0.6); ctx.lineTo(x + w * 0.45, yB + hB * 0.6); ctx.fill();
        ctx.fillStyle = C.allume; ctx.beginPath(); ctx.arc(x + w * 0.25, yB + 10, 5, 0, Math.PI * 2); ctx.fill();
        rect(ctx, x, yB + hB * 0.85, w, hB * 0.15, C.silhouette);
        vitrinesX.push([x, w]);
      }
      x += w + ecart;
    }

    // Récit : étals devant les vitrines, qui débordent sur le trottoir
    d.C.etals.forEach((n, i) => {
      const [vx, vw] = vitrinesX[i % Math.max(1, vitrinesX.length)] || [x0, W];
      const cw = Math.min(46, vw / 3.4), ch = cw * 0.62, parRang = 3;
      for (let k = 0; k < n; k++) {
        const rang = Math.floor(k / parRang), dansRang = Math.min(parRang, n - rang * parRang), pos = k % parRang;
        const bx = vx + vw / 2 - dansRang * (cw + 4) / 2 + pos * (cw + 4), by = sol + 10 - (rang + 1) * (ch + 3);
        rect(ctx, bx, by, cw, ch, C.recit);
        rect(ctx, bx, by + ch * 0.45, cw, 2, "rgba(0,0,0,.3)");
      }
    });

    // Repères A / B / C
    const lx = x1 + 44;
    ctx.strokeStyle = "#E6E6EA"; ctx.fillStyle = "#E6E6EA"; ctx.lineWidth = 2;
    ctx.font = "700 30px Changa, sans-serif"; ctx.textAlign = "left";
    for (const [l, y0, y1] of [["A", haut, yA], ["B", yA, yC], ["C", yC, sol]]) {
      ctx.beginPath(); ctx.moveTo(lx - 8, y0 + 3); ctx.lineTo(lx, y0 + 3); ctx.lineTo(lx, y1 - 3); ctx.lineTo(lx - 8, y1 - 3); ctx.stroke();
      ctx.fillText(l, lx + 10, (y0 + y1) / 2);
    }
    return { cv, M };
  }

  /* ---------- Contrôles automatiques (étape 6) ---------- */
  function controler(brut, d, M) {
    const r = [], ok = (b, t) => r.push({ ok: b, t });
    const total = d.B.niveaux * d.B.colonnes, al = d.B.allumees, pct = Math.round(al.length / total * 100);
    const dedans = ([c, n]) => c >= 0 && c < d.B.colonnes && n >= 0 && n < d.B.niveaux;
    ok(!!brut.nom, "Le bâtiment a un nom");
    ok(+brut.ratio >= 0.4 && +brut.ratio <= 4, `Proportions plausibles (hauteur/largeur ${(+brut.ratio || 0).toString().replace(".", ",")})`);
    ok([...al, ...d.B.clim, ...d.B.rideaux].every(dedans), "Toutes les positions (allumées, clim, rideaux) sont dans la grille");
    ok(total < 2 || (pct >= 30 && pct <= 50), `Fenêtres allumées : ${al.length} sur ${total} (${pct} %, cible 30 à 50 %)`);
    const lignes = al.map(p => p[1]), cols = al.map(p => p[0]);
    ok(new Set(lignes).size === lignes.length && new Set(cols).size === cols.length, "Allumées en damier : jamais deux sur la même ligne ni la même colonne");
    ok(M.ww >= 24, "Le module fenêtre est assez grand pour être lisible");
    ok(d.A.part + d.C.part < 0.75, "Les blocs A et C laissent de la place aux étages");
    ok(d.C.vitrines + 1 <= 8, "Le rez-de-chaussée n'est pas trop chargé (8 éléments max)");
    d.ecarts.forEach(e => r.push({ ok: null, t: `Écart signalé : ${e}` }));
    return r;
  }

  /* ---------- Assemblage de la planche (étape 5) ---------- */
  function planche(img, d, decoupe, M) {
    const cv = document.createElement("canvas");
    cv.width = 2310; cv.height = 2360;
    const ctx = cv.getContext("2d");
    rect(ctx, 0, 0, 2310, 2360, C.planche);
    const blanc = "#F2EFE6", doux = "#9C9AA3";
    const texte = (t, x, y, taille, poids = 400, couleur = blanc, police = "Commissioner") => {
      ctx.font = `${poids} ${taille}px ${police}, sans-serif`; ctx.fillStyle = couleur; ctx.fillText(t, x, y);
    };
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    texte("Référence", 50, 92, 48, 700, blanc, "Changa");
    texte("Découpe", 1180, 92, 48, 700, blanc, "Changa");

    // Photo sans déformation dans un cadre 1080 × 1350
    rect(ctx, 50, 120, 1080, 1350, "#0E0E10");
    const e = Math.min(1080 / img.naturalWidth, 1350 / img.naturalHeight);
    const w = img.naturalWidth * e, h = img.naturalHeight * e;
    ctx.drawImage(img, 50 + (1080 - w) / 2, 120 + (1350 - h) / 2, w, h);
    ctx.drawImage(decoupe, 1180, 120);

    texte(d.nom, 50, 1560, 64, 800, blanc, "Changa");
    const resume = [`Vue de face redressée`, `bâtiment centré`, `3 blocs : A couronnement, B ${d.B.niveaux} étage${d.B.niveaux > 1 ? "s" : ""}, C rez-de-chaussée`, ...d.ecarts].join(" · ");
    texte(resume, 50, 1615, 30, 400, doux);
    rect(ctx, 50, 1650, 2210, 3, "#2E2E34");

    // Colonne 1 : couleurs et zones
    texte("Couleurs et zones", 50, 1720, 36, 700, blanc, "Changa");
    ZONES.forEach(([k, nom], i) => {
      const col = i < 8 ? 0 : 1, y = 1760 + (i % 8) * 64;
      rect(ctx, 50 + col * 340, y, 40, 40, C[k]);
      texte(nom, 104 + col * 340, y + 30, 26);
    });

    // Colonne 2 : éléments dupliqués
    texte("Éléments dupliqués", 790, 1720, 36, 700, blanc, "Changa");
    const total = d.B.niveaux * d.B.colonnes;
    const pos = p => `col. ${p[0] + 1} / niv. ${p[1] + 1}`;
    const lignes = [
      d.A.consoles && `${d.A.consoles} consoles (tête + corps + goutte)`,
      d.A.panneaux && `${d.A.panneaux} panneaux de corniche`,
      `${d.B.colonnes} × ${d.B.niveaux} = ${total} fenêtres (linteau, cadre, 2 vantaux, appui)`,
      `${d.B.allumees.length} allumée${d.B.allumees.length > 1 ? "s" : ""} en damier : ${d.B.allumees.map(pos).join(", ") || "aucune"}`,
      d.B.clim.length && `Clim : ${d.B.clim.map(pos).join(", ")}`,
      d.B.rideaux.length && `Rideaux : ${d.B.rideaux.map(pos).join(", ")}`,
      d.B.niveaux > 1 && `${d.B.niveaux - 1} bandeau${d.B.niveaux > 2 ? "x" : ""} entre étages`,
      d.C.bandes && `Store : ${d.C.bandes} bandes et ${d.C.bandes} festons`,
      `${d.C.vitrines} vitrine${d.C.vitrines > 1 ? "s" : ""} (meneau + spot), porte ${d.C.porte === "centre" ? "au centre" : "à " + d.C.porte}`,
      d.C.pilastres && `${d.C.pilastres} pilastres`,
      d.C.etals.length && `Étals : ${d.C.etals.reduce((s, n) => s + n, 0)} caisses (${d.C.etals.join(" + ")})`
    ].filter(Boolean);
    lignes.forEach((l, i) => texte("• " + l, 790, 1780 + i * 50, 27));

    // Colonne 3 : zoom sur le module fenêtre, puis ce qui est supprimé
    texte("Module fenêtre", 1560, 1720, 36, 700, blanc, "Changa");
    const variante = d.B.clim[0] || d.B.rideaux[0] || d.B.allumees[0] || [0, 0];
    const vari = [...Array(d.B.niveaux * d.B.colonnes)].map((_, i) => [i % d.B.colonnes, Math.floor(i / d.B.colonnes)]);
    const zoom = (p, x) => {
      const cx = M.x0 + M.colW * (p[0] + 0.5), y = M.yA + p[1] * M.rowH + M.rowH * 0.22;
      const sw = M.ww + 30, sh = M.wh + 34, e2 = Math.min(300 / sw, 260 / sh);
      ctx.drawImage(decoupe, cx - sw / 2, y - 18, sw, sh, x, 1750, sw * e2, sh * e2);
      return sw * e2;
    };
    const type = vari.find(p => !d.B.allumees.concat(d.B.clim, d.B.rideaux).some(q => q[0] === p[0] && q[1] === p[1])) || [0, 0];
    const l1 = zoom(type, 1560);
    texte("type", 1560, 2050, 24, 400, doux);
    if (variante[0] !== type[0] || variante[1] !== type[1]) {
      zoom(variante, 1560 + l1 + 30);
      texte("variante", 1560 + l1 + 30, 2050, 24, 400, doux);
    }
    texte("Supprimé", 1560, 2110, 30, 700, blanc, "Changa");
    (d.supprime.length ? d.supprime : ["rien"]).slice(0, 6).forEach((s, i) => texte("× " + s, 1560, 2155 + i * 36, 25, 400, doux));
    return cv;
  }

  /* ---------- Interface ---------- */
  const echap = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const versBlob = cv => new Promise(ok => cv.toBlob(ok, "image/png"));
  const lireCle = () => { try { return localStorage.getItem(CLE_API) || ""; } catch { return ""; } };
  const VERIF_MAIN = [
    "Le nombre de niveaux, de colonnes de fenêtres et de consoles correspond à la photo",
    "Les zones ne sortent pas de la façade (sauf store et étals, qui débordent exprès)",
    "Les étiquettes et la légende sont lisibles et ne coupent rien",
    "Chaque écart volontaire avec la photo est signalé"
  ];

  const champCle = document.getElementById("d-cle");
  if (champCle) {
    champCle.value = lireCle();
    champCle.addEventListener("change", () => {
      try { champCle.value.trim() ? localStorage.setItem(CLE_API, champCle.value.trim()) : localStorage.removeItem(CLE_API); } catch {}
    });
  }

  window.decoupeFacade = async function (fichier, { telecharger, nomPropre }) {
    const bloc = document.createElement("div");
    bloc.className = "resultat-lego resultat-facade";
    bloc.innerHTML = `<div class="res-infos"><strong>${echap(fichier.name)}</strong><span>Chargement…</span></div>`;
    document.getElementById("resultats-droplet").prepend(bloc);
    const etat = t => { const s = bloc.querySelector(".res-infos span"); if (s) s.textContent = t; };

    const img = new Image();
    img.src = URL.createObjectURL(fichier);
    try { await img.decode(); } catch { etat("Impossible de lire ce fichier"); return; }
    await document.fonts?.ready;

    let brut = MODELE_JSON, note = "Pas de clé : modèle à corriger à la main ci-dessous.";
    const cle = lireCle();
    if (cle) {
      etat("Analyse de la façade…");
      try { brut = await analyser(img, cle); note = "Analyse faite. Vérifie et corrige la description si besoin."; }
      catch (e) { note = `Analyse impossible (${e.message}). Modèle à corriger à la main ci-dessous.`; }
    }
    const base = nomPropre(fichier.name);

    async function rendre(brut) {
      const d = normaliser(brut);
      const { cv, M } = dessiner(d);
      const pl = planche(img, d, cv, M);
      const [pngPlanche, pngDecoupe] = await Promise.all([versBlob(pl), versBlob(cv)]);
      const controles = controler(brut, d, M);
      bloc.innerHTML = `
        <img class="lego-apercu" src="${URL.createObjectURL(pngPlanche)}" alt="Planche de découpe">
        <div class="res-infos"><strong>${echap(d.nom)}</strong><span>${echap(note)}</span></div>
        <ul class="facade-controles">${controles.map(c => `<li class="${c.ok === null ? "info" : c.ok ? "bon" : "faux"}">${c.ok === null ? "ℹ" : c.ok ? "✓" : "⚠"} ${echap(c.t)}</li>`).join("")}</ul>
        <details class="facade-json"><summary>Description (JSON) à corriger</summary>
          <textarea spellcheck="false">${echap(JSON.stringify(brut, null, 2))}</textarea>
          <button class="btn-texte petit-net" data-a="redessiner">↻ Redessiner</button>
        </details>
        <fieldset class="facade-verif"><legend>Avant de valider, compare à la photo</legend>
          ${VERIF_MAIN.map(t => `<label><input type="checkbox"> ${echap(t)}</label>`).join("")}
        </fieldset>
        <div class="lego-boutons">
          <button class="btn-plein petit" data-a="planche" disabled>⬇ Planche</button>
          <button class="btn-texte petit-net" data-a="decoupe">⬇ Découpe</button>
          <button class="btn-texte petit-net" data-a="json">⬇ JSON</button>
        </div>`;
      const cases = [...bloc.querySelectorAll(".facade-verif input")], btn = bloc.querySelector('[data-a="planche"]');
      cases.forEach(c => c.addEventListener("change", () => { btn.disabled = !cases.every(x => x.checked); }));
      btn.addEventListener("click", () => telecharger(pngPlanche, `${base}-planche.png`));
      bloc.querySelector('[data-a="decoupe"]').addEventListener("click", () => telecharger(pngDecoupe, `${base}-decoupe.png`));
      bloc.querySelector('[data-a="json"]').addEventListener("click", () =>
        telecharger(new Blob([bloc.querySelector("textarea").value], { type: "application/json" }), `${base}-description.json`));
      bloc.querySelector('[data-a="redessiner"]').addEventListener("click", () => {
        try { note = "Redessiné avec ta description."; rendre(JSON.parse(bloc.querySelector("textarea").value)); }
        catch { bloc.querySelector("summary").textContent = "⚠ JSON invalide : vérifie les virgules et guillemets"; }
      });
    }
    await rendre(brut);
  };

  // Auto-contrôle au chargement : le modèle de départ doit passer tous les contrôles
  (() => {
    const d = normaliser(MODELE_JSON), M = mesures(d);
    const ko = controler(MODELE_JSON, d, M).filter(c => c.ok === false);
    if (ko.length) console.warn("Découpe façade : le modèle de départ échoue", ko);
    const mauvais = controler({ ...MODELE_JSON, etages: { ...MODELE_JSON.etages, allumees: [[0, 0], [0, 1]] } }, normaliser({ ...MODELE_JSON, etages: { ...MODELE_JSON.etages, allumees: [[0, 0], [0, 1]] } }), M);
    if (!mauvais.some(c => c.ok === false && /damier/.test(c.t))) console.warn("Découpe façade : le contrôle du damier ne détecte rien");
  })();
})();
