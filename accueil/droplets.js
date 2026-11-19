/* ==========================================================
   Droplets : on dépose une image, elle est traitée sur place.
   Rien n'est envoyé sur internet.
   - Export web : redimensionne + compresse (WebP / JPEG / PNG)
   - Mosaïque LEGO : vue de dessus, en tenons, avec liste des pièces
   ========================================================== */
"use strict";
(() => {
  const $ = s => document.querySelector(s);

  /* Couleurs LEGO courantes (valeurs approchées) */
  const LEGO = [
    ["Black", "#05131D"], ["White", "#FFFFFF"], ["Light Bluish Gray", "#A0A5A9"], ["Dark Bluish Gray", "#6C6E68"],
    ["Red", "#C91A09"], ["Dark Red", "#720E0F"], ["Orange", "#FE8A18"], ["Dark Orange", "#A95500"],
    ["Yellow", "#F2CD37"], ["Bright Light Yellow", "#FFF03A"], ["Lime", "#BBE90B"], ["Green", "#237841"],
    ["Dark Green", "#184632"], ["Sand Green", "#A0BCAC"], ["Blue", "#0055BF"], ["Dark Blue", "#0A3463"],
    ["Dark Azure", "#078BC9"], ["Medium Azure", "#36AEBF"], ["Bright Light Blue", "#9FC3E9"], ["Tan", "#E4CD9E"],
    ["Dark Tan", "#958A73"], ["Reddish Brown", "#582A12"], ["Medium Nougat", "#AA7D55"], ["Nougat", "#D09168"],
    ["Light Nougat", "#F6D7B3"], ["Bright Pink", "#E4ADC8"], ["Dark Pink", "#C870A0"], ["Magenta", "#923978"],
    ["Coral", "#FF698F"], ["Medium Lavender", "#AC78BA"], ["Dark Purple", "#3F3691"]
  ].map(([nom, hex]) => {
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    return { nom, hex, rgb, lab: versLab(rgb) };
  });

  /* ---------- Outils couleur ---------- */
  function versLab([r, g, b]) {
    const lin = c => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
    const R = lin(r), G = lin(g), B = lin(b);
    let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
    let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    x = f(x); y = f(y); z = f(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  function plusProche(rgb, palette) {
    const [L, A, B] = versLab(rgb);
    let meilleur = palette[0], d = Infinity;
    for (const c of palette) {
      const dl = L - c.lab[0], da = A - c.lab[1], db = B - c.lab[2];
      const dist = dl * dl + da * da + db * db;
      if (dist < d) { d = dist; meilleur = c; }
    }
    return meilleur;
  }

  /* ---------- Outils fichiers ---------- */
  const taille = o => o < 1024 ? `${o} o` : o < 1048576 ? `${Math.round(o / 1024)} Ko` : `${(o / 1048576).toFixed(1).replace(".", ",")} Mo`;
  const sansExt = n => n.replace(/\.[^.]+$/, "");
  const propre = n => sansExt(n).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "image";

  function chargerImage(fichier) {
    return new Promise((ok, ko) => {
      const url = URL.createObjectURL(fichier);
      const img = new Image();
      img.onload = () => ok({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("illisible")); };
      img.src = url;
    });
  }
  const versBlob = (canvas, type, q) => new Promise(ok => canvas.toBlob(ok, type, q));

  function telecharger(blob, nom) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nom;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const notifier = msg => { if (typeof window.toast === "function") window.toast(msg); };

  /* ---------- Réglages mémorisés ---------- */
  const CLE = "phantaccueil_droplets";
  let O = { mode: "web", largeur: 1600, format: "image/webp", qualite: 80, tenons: 48, tramage: false };
  try { O = { ...O, ...JSON.parse(localStorage.getItem(CLE) || "{}") }; } catch {}
  const memoriser = () => { try { localStorage.setItem(CLE, JSON.stringify(O)); } catch {} };

  /* ---------- Interface ---------- */
  function majOnglets() {
    document.querySelectorAll(".droplet-onglet").forEach(b => b.setAttribute("aria-selected", String(b.dataset.d === O.mode)));
    $("#opt-web").hidden = O.mode !== "web";
    $("#opt-lego").hidden = O.mode !== "lego";
    $("#zone-texte").textContent = O.mode === "web" ? "Dépose tes images ici" : "Dépose une image ici";
    $("#fichier-droplet").multiple = O.mode === "web";
  }
  function majQualite() {
    $("#d-qualite-val").textContent = O.format === "image/png" ? "sans perte" : O.qualite + " %";
    $("#d-qualite").disabled = O.format === "image/png";
  }

  document.querySelectorAll(".droplet-onglet").forEach(b => b.addEventListener("click", () => {
    O.mode = b.dataset.d; memoriser(); majOnglets();
  }));
  const lier = (sel, cle, conv = v => v) => {
    const el = $(sel);
    if (el.type === "checkbox") el.checked = O[cle]; else el.value = O[cle];
    el.addEventListener("input", () => { O[cle] = el.type === "checkbox" ? el.checked : conv(el.value); memoriser(); majQualite(); });
  };
  lier("#d-largeur", "largeur", Number);
  lier("#d-format", "format");
  lier("#d-qualite", "qualite", Number);
  lier("#d-tenons", "tenons", Number);
  lier("#d-tramage", "tramage");
  majOnglets();
  majQualite();

  // Choisir un fichier (clic / téléphone)
  $("#fichier-droplet").addEventListener("change", e => {
    traiter([...e.target.files]);
    e.target.value = "";
  });

  // Glisser-déposer : sur la zone ou n'importe où sur la page
  const zone = $("#zone-depot");
  let compteur = 0;
  document.addEventListener("dragenter", e => {
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    compteur++; zone.classList.add("survol");
  });
  document.addEventListener("dragleave", () => { if (--compteur <= 0) { compteur = 0; zone.classList.remove("survol"); } });
  document.addEventListener("dragover", e => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    compteur = 0; zone.classList.remove("survol");
    traiter([...e.dataTransfer.files]);
  });

  function traiter(fichiers) {
    const images = fichiers.filter(f => f.type.startsWith("image/"));
    if (!images.length) { notifier("Ce n'est pas une image"); return; }
    $("#zone-depot").scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (O.mode === "web") images.forEach(exportWeb);
    else mosaique(images[0]);
  }

  /* ---------- Droplet 1 : Export web ---------- */
  async function exportWeb(fichier) {
    const ligne = document.createElement("div");
    ligne.className = "resultat";
    ligne.innerHTML = `<div class="res-vignette"></div><div class="res-infos"><strong>${echap(fichier.name)}</strong><span>Compression…</span></div>`;
    $("#resultats-droplet").prepend(ligne);
    try {
      const { img, url } = await chargerImage(fichier);
      const echelle = Math.min(1, O.largeur / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * echelle), h = Math.round(img.naturalHeight * echelle);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      if (O.format === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(img, 0, 0, w, h);
      let blob = await versBlob(c, O.format, O.qualite / 100);
      let ext = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" }[O.format];
      if (!blob || blob.type !== O.format) { blob = await versBlob(c, "image/jpeg", O.qualite / 100); ext = "jpg"; }
      const nom = `${propre(fichier.name)}-web.${ext}`;
      const gain = Math.round((1 - blob.size / fichier.size) * 100);
      ligne.querySelector(".res-vignette").innerHTML = `<img src="${url}" alt="">`;
      ligne.querySelector(".res-infos").innerHTML = `
        <strong title="${echap(nom)}">${echap(nom)}</strong>
        <span>${w} × ${h} px · ${taille(fichier.size)} → <b>${taille(blob.size)}</b>
        ${gain > 0 ? `<em class="gain">−${gain} %</em>` : `<em class="perte">+${-gain} %</em>`}</span>`;
      const bouton = document.createElement("button");
      bouton.className = "btn-plein petit";
      bouton.textContent = "⬇";
      bouton.title = "Télécharger";
      bouton.addEventListener("click", () => telecharger(blob, nom));
      ligne.appendChild(bouton);
    } catch {
      ligne.querySelector(".res-infos span").textContent = "Impossible de lire ce fichier";
    }
  }

  /* ---------- Droplet 2 : Mosaïque LEGO ---------- */
  async function mosaique(fichier) {
    const bloc = document.createElement("div");
    bloc.className = "resultat-lego";
    bloc.innerHTML = `<div class="res-infos"><strong>${echap(fichier.name)}</strong><span>Assemblage des briques…</span></div>`;
    $("#resultats-droplet").prepend(bloc);
    await new Promise(r => setTimeout(r, 30));
    try {
      const { img, url } = await chargerImage(fichier);
      URL.revokeObjectURL(url);
      const W = O.tenons;
      const H = Math.max(1, Math.round(W * img.naturalHeight / img.naturalWidth));

      // 1. Réduire l'image à 1 pixel par tenon
      const petit = document.createElement("canvas");
      petit.width = W; petit.height = H;
      const pctx = petit.getContext("2d", { willReadFrequently: true });
      pctx.imageSmoothingQuality = "high";
      pctx.fillStyle = "#fff"; pctx.fillRect(0, 0, W, H);
      pctx.drawImage(img, 0, 0, W, H);
      const px = pctx.getImageData(0, 0, W, H).data;
      const buf = new Float32Array(W * H * 3);
      for (let i = 0; i < W * H; i++) { buf[i * 3] = px[i * 4]; buf[i * 3 + 1] = px[i * 4 + 1]; buf[i * 3 + 2] = px[i * 4 + 2]; }

      // 2. Choisir la couleur LEGO la plus proche (avec tramage si demandé)
      const grille = new Array(W * H);
      const diffuser = (x, y, er, eg, eb, k) => {
        if (x < 0 || x >= W || y >= H) return;
        const j = (y * W + x) * 3;
        buf[j] += er * k; buf[j + 1] += eg * k; buf[j + 2] += eb * k;
      };
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        const rgb = [buf[i], buf[i + 1], buf[i + 2]].map(v => Math.max(0, Math.min(255, v)));
        const c = plusProche(rgb, LEGO);
        grille[y * W + x] = c;
        if (O.tramage) {
          const er = (rgb[0] - c.rgb[0]) * 0.75, eg = (rgb[1] - c.rgb[1]) * 0.75, eb = (rgb[2] - c.rgb[2]) * 0.75;
          diffuser(x + 1, y, er, eg, eb, 7 / 16);
          diffuser(x - 1, y + 1, er, eg, eb, 3 / 16);
          diffuser(x, y + 1, er, eg, eb, 5 / 16);
          diffuser(x + 1, y + 1, er, eg, eb, 1 / 16);
        }
      }

      // 3. Dessiner les tenons vus de dessus
      const T = Math.max(10, Math.min(24, Math.floor(1800 / W)));
      const rendu = document.createElement("canvas");
      rendu.width = W * T; rendu.height = H * T;
      const ctx = rendu.getContext("2d");
      const r = T * 0.32;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = grille[y * W + x];
        const X = x * T, Y = y * T;
        ctx.fillStyle = c.hex;
        ctx.fillRect(X, Y, T, T);
        ctx.strokeStyle = "rgba(0,0,0,.18)";
        ctx.lineWidth = 1;
        ctx.strokeRect(X + .5, Y + .5, T - 1, T - 1);
        // ombre du tenon
        ctx.beginPath(); ctx.arc(X + T / 2 + T * .05, Y + T / 2 + T * .06, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,.28)"; ctx.fill();
        // tenon
        ctx.beginPath(); ctx.arc(X + T / 2, Y + T / 2, r, 0, Math.PI * 2);
        ctx.fillStyle = c.hex; ctx.fill();
        // reflet
        ctx.beginPath(); ctx.arc(X + T / 2, Y + T / 2, r, Math.PI * 1.05, Math.PI * 1.6);
        ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.lineWidth = Math.max(1, T * .07); ctx.stroke();
      }

      // 4. Liste des pièces
      const compte = new Map();
      for (const c of grille) compte.set(c, (compte.get(c) || 0) + 1);
      const liste = [...compte.entries()].sort((a, b) => b[1] - a[1]);
      const total = W * H;
      const base = propre(fichier.name);
      const csv = "Couleur LEGO;Hex;Quantité (1x1)\n" + liste.map(([c, n]) => `${c.nom};${c.hex};${n}`).join("\n") + `\nTotal;;${total}\n`;
      const png = await versBlob(rendu, "image/png");

      const plaques = Math.ceil(W / 16) * Math.ceil(H / 16);
      bloc.innerHTML = `
        <img class="lego-apercu" src="${URL.createObjectURL(png)}" alt="Mosaïque LEGO">
        <div class="res-infos">
          <strong>${W} × ${H} tenons · ${total.toLocaleString("fr-FR")} pièces · ${liste.length} couleurs</strong>
          <span>≈ ${(W * 0.8).toFixed(1).replace(".", ",")} × ${(H * 0.8).toFixed(1).replace(".", ",")} cm · ${plaques} plaque${plaques > 1 ? "s" : ""} 16×16</span>
        </div>
        <ul class="lego-liste">${liste.map(([c, n]) => `<li title="${c.nom} ${c.hex}"><i style="background:${c.hex}"></i>${n}</li>`).join("")}</ul>
        <div class="lego-boutons">
          <button class="btn-plein petit" data-a="png">⬇ Image</button>
          <button class="btn-texte petit-net" data-a="csv">⬇ Liste des pièces</button>
        </div>`;
      bloc.querySelector('[data-a="png"]').addEventListener("click", () => telecharger(png, `${base}-lego-${W}x${H}.png`));
      bloc.querySelector('[data-a="csv"]').addEventListener("click", () => telecharger(new Blob(["﻿" + csv], { type: "text/csv" }), `${base}-lego-pieces.csv`));
    } catch {
      bloc.querySelector(".res-infos span").textContent = "Impossible de lire ce fichier";
    }
  }

  function echap(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  $("#btn-vider-droplets").addEventListener("click", () => { $("#resultats-droplet").innerHTML = ""; });
})();
