/* ==========================================================
   PhantStudio — page Nouvel onglet
   Tout est enregistré dans Chrome (chrome.storage.local), sur cet ordi.
   ========================================================== */
"use strict";

/* ---------- Données par défaut ---------- */
const PALETTE = [
  { nom: "Sable", hex: "#CEB694", texte: "#1B1A18" },
  { nom: "Encre", hex: "#1B1A18", texte: "#CEB694" },
  { nom: "Rouge", hex: "#CC0C33", texte: "#CEB694" },
  { nom: "Jaune", hex: "#D1A802", texte: "#1B1A18" },
  { nom: "Turquoise", hex: "#02968A", texte: "#CEB694" },
  { nom: "Sarcelle", hex: "#006B6E", texte: "#CEB694" }
];

const GROUPES_DEFAUT = [
  { nom: "Studio", couleur: "rouge", liens: [
    ["Suivis Phant", "https://adrienfeuilloy.github.io/phant-studio-app/"],
    ["Mon site", "https://adrienfeuilloy.github.io/Phant-site/"],
    ["Ancien site (Nordcraft)", "https://phantstudio.nordcraft.site/"],
    ["GitHub", "https://github.com/AdrienFeuilloy"]
  ]},
  { nom: "Com", couleur: "turquoise", liens: [
    ["Instagram", "https://www.instagram.com/"],
    ["Meta Business Suite", "https://business.facebook.com/latest/home"],
    ["Fiche Google", "https://business.google.com/"],
    ["Google Search Console", "https://search.google.com/search-console"]
  ]},
  { nom: "Inspi", couleur: "jaune", liens: [
    ["Pinterest", "https://www.pinterest.fr/"],
    ["Behance", "https://www.behance.net/"],
    ["Dribbble", "https://dribbble.com/"],
    ["Fonts In Use", "https://fontsinuse.com/"]
  ]},
  { nom: "Ressources", couleur: "sarcelle", liens: [
    ["Google Fonts", "https://fonts.google.com/"],
    ["Coolors", "https://coolors.co/"],
    ["Unsplash", "https://unsplash.com/"],
    ["Squoosh (images web)", "https://squoosh.app/"]
  ]},
  { nom: "Admin", couleur: "sable", liens: [
    ["Gmail", "https://mail.google.com/"],
    ["Google Agenda", "https://calendar.google.com/"],
    ["Google Drive", "https://drive.google.com/"],
    ["WeTransfer", "https://wetransfer.com/"],
    ["Qonto", "https://app.qonto.com/"],
    ["Revolut Business", "https://business.revolut.com/"]
  ]},
  { nom: "Assistants", couleur: "turquoise", liens: [
    ["Google AI Studio", "https://aistudio.google.com/"]
  ]}
];

const MOTEURS = [
  { id: "google", nom: "Google", url: "https://www.google.com/search?q=" },
  { id: "images", nom: "Images", url: "https://www.google.com/search?tbm=isch&q=" },
  { id: "pinterest", nom: "Pinterest", url: "https://www.pinterest.fr/search/pins/?q=" },
  { id: "behance", nom: "Behance", url: "https://www.behance.net/search/projects?search=" },
  { id: "dribbble", nom: "Dribbble", url: "https://dribbble.com/search/" },
  { id: "fonts", nom: "Google Fonts", url: "https://fonts.google.com/?query=" },
  { id: "unsplash", nom: "Unsplash", url: "https://unsplash.com/s/photos/" }
];

const REGLAGES_DEFAUT = { prenom: "Adrien", taux: 35, ville: "", mode: "sombre", moteur: "google" };

/* ---------- Stockage ---------- */
// Préfixe propre à cette page : ne touche jamais aux données des autres applis
// hébergées à la même adresse (Suivis Phant, etc.).
const PREFIXE = "phantaccueil_";
const enExtension = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
const stock = {
  async lire(cles) {
    if (enExtension) return chrome.storage.local.get(cles);
    const r = {};
    for (const c of cles) { const v = localStorage.getItem(PREFIXE + c); if (v !== null) r[c] = JSON.parse(v); }
    return r;
  },
  async ecrire(obj) {
    if (enExtension) return chrome.storage.local.set(obj);
    for (const [c, v] of Object.entries(obj)) localStorage.setItem(PREFIXE + c, JSON.stringify(v));
  },
  async tout() {
    if (enExtension) return chrome.storage.local.get(null);
    return this.lire(["reglages", "groupes", "taches", "notes", "meteoCache"]);
  },
  async vider() {
    if (enExtension) return chrome.storage.local.clear();
    Object.keys(localStorage).filter(k => k.startsWith(PREFIXE)).forEach(k => localStorage.removeItem(k));
  }
};

/* ---------- État ---------- */
let R = { ...REGLAGES_DEFAUT };
let groupes = [];
let taches = [];
let astuceIndex = 0;

const $ = s => document.querySelector(s);
const id = () => Math.random().toString(36).slice(2, 9);
const enregistrer = obj => stock.ecrire(obj);

function groupesDepuisDefaut() {
  return GROUPES_DEFAUT.map(g => ({
    id: id(), nom: g.nom, couleur: g.couleur,
    liens: g.liens.map(([nom, url]) => ({ id: id(), nom, url }))
  }));
}

/* ---------- Toast ---------- */
let toastMinuteur;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("visible");
  clearTimeout(toastMinuteur);
  toastMinuteur = setTimeout(() => t.classList.remove("visible"), 1800);
}

/* ---------- Horloge & salut ---------- */
function majHorloge() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  $("#horloge").innerHTML = `${h}<span class="deux-points">:</span>${m}`;

  const heure = d.getHours();
  let bonjour = "Bonjour";
  if (heure < 5) bonjour = "Encore debout";
  else if (heure < 12) bonjour = "Bonjour";
  else if (heure < 18) bonjour = "Bon après-midi";
  else bonjour = "Bonsoir";

  const date = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const restantes = taches.filter(t => !t.faite).length;
  const prog = restantes === 0 ? "rien au programme, à toi de jouer"
    : restantes === 1 ? "1 tâche au programme" : `${restantes} tâches au programme`;
  const prenom = R.prenom ? ` <strong>${echapper(R.prenom)}</strong>` : "";
  $("#salut").innerHTML = `${bonjour}${prenom}${heure < 5 ? " ?" : ""} · ${date} · ${prog}`;
}

function echapper(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Mode clair / sombre ---------- */
function appliquerMode() { document.documentElement.dataset.mode = R.mode; }
$("#btn-mode").addEventListener("click", () => {
  R.mode = R.mode === "sombre" ? "clair" : "sombre";
  appliquerMode();
  enregistrer({ reglages: R });
});

/* ---------- Recherche ---------- */
function rendreMoteurs() {
  const box = $("#moteurs");
  box.innerHTML = "";
  for (const m of MOTEURS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "moteur";
    b.textContent = m.nom;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(R.moteur === m.id));
    b.addEventListener("click", () => {
      R.moteur = m.id;
      enregistrer({ reglages: R });
      rendreMoteurs();
      $("#champ-recherche").focus();
    });
    box.appendChild(b);
  }
  const actif = MOTEURS.find(m => m.id === R.moteur) || MOTEURS[0];
  $("#champ-recherche").placeholder = `Cherche sur ${actif.nom}…`;
}

$("#form-recherche").addEventListener("submit", e => {
  e.preventDefault();
  const q = $("#champ-recherche").value.trim();
  if (!q) return;
  // Si on tape une adresse, on y va directement
  if (/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(q) && !q.includes(" ")) {
    location.href = /^https?:\/\//i.test(q) ? q : "https://" + q;
    return;
  }
  const m = MOTEURS.find(m => m.id === R.moteur) || MOTEURS[0];
  location.href = m.url + encodeURIComponent(q);
});

/* ---------- Raccourcis (cartouches) ---------- */
function favicon(url) {
  if (enExtension && chrome.runtime && chrome.runtime.getURL) {
    const u = new URL(chrome.runtime.getURL("/_favicon/"));
    u.searchParams.set("pageUrl", url);
    u.searchParams.set("size", "32");
    return u.toString();
  }
  // Version web (Android) : icônes fournies par Google
  const d = domaine(url);
  return d ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64` : null;
}
function domaine(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function rendreGroupes() {
  const box = $("#groupes");
  box.innerHTML = "";
  for (const g of groupes) {
    const art = document.createElement("article");
    art.className = `cartouche c-${g.couleur}`;
    art.innerHTML = `
      <div class="cartouche-etiquette">
        <h2>${echapper(g.nom)}</h2>
        <button class="btn-edit-groupe" title="Modifier la cartouche">✎</button>
        <span class="rainures"><i></i><i></i><i></i></span>
      </div>
      <ul class="liens"></ul>
      <button class="btn-ajout-lien">+ Ajouter un lien</button>`;
    const ul = art.querySelector(".liens");
    for (const l of g.liens) {
      const li = document.createElement("li");
      li.className = "lien";
      const a = document.createElement("a");
      a.href = l.url;
      const fav = favicon(l.url);
      const initiale = echapper((l.nom || "?").trim().charAt(0).toUpperCase());
      a.innerHTML = `
        <span class="favicon${fav ? " avec-image" : ""}">${fav ? `<img src="${fav}" alt="">` : initiale}</span>
        <span class="nom">${echapper(l.nom)}</span>`;
      a.title = domaine(l.url);
      const img = a.querySelector("img");
      if (img) img.addEventListener("error", () => {
        const f = a.querySelector(".favicon");
        f.classList.remove("avec-image");
        f.textContent = (l.nom || "?").trim().charAt(0).toUpperCase();
      });
      a.addEventListener("click", e => {
        if (document.body.classList.contains("edition")) {
          e.preventDefault();
          ouvrirDlgLien(g.id, l.id);
        }
      });
      li.appendChild(a);
      ul.appendChild(li);
    }
    art.querySelector(".btn-ajout-lien").addEventListener("click", () => ouvrirDlgLien(g.id, null));
    art.querySelector(".btn-edit-groupe").addEventListener("click", () => ouvrirDlgGroupe(g.id));
    box.appendChild(art);
  }
}

$("#btn-edition").addEventListener("click", () => {
  const actif = document.body.classList.toggle("edition");
  $("#btn-edition").setAttribute("aria-pressed", String(actif));
  toast(actif ? "Mode édition : clique sur un lien pour le modifier" : "Modifications terminées");
});

/* Fenêtre lien */
let lienEdite = null; // { groupeId, lienId }
function ouvrirDlgLien(groupeId, lienId) {
  lienEdite = { groupeId, lienId };
  const sel = $("#lien-groupe");
  sel.innerHTML = groupes.map(g => `<option value="${g.id}">${echapper(g.nom)}</option>`).join("");
  sel.value = groupeId;
  const g = groupes.find(g => g.id === groupeId);
  const l = lienId ? g.liens.find(l => l.id === lienId) : null;
  $("#dlg-lien-titre").textContent = l ? "Modifier le raccourci" : "Nouveau raccourci";
  $("#lien-nom").value = l ? l.nom : "";
  $("#lien-url").value = l ? l.url : "";
  $("#lien-supprimer").hidden = !l;
  $("#dlg-lien").returnValue = "";
  $("#dlg-lien").showModal();
}
$("#dlg-lien").addEventListener("close", () => {
  if ($("#dlg-lien").returnValue !== "ok" || !lienEdite) return;
  let url = $("#lien-url").value.trim();
  if (!/^[a-z]+:\/\//i.test(url)) url = "https://" + url;
  const nom = $("#lien-nom").value.trim() || domaine(url);
  const cible = groupes.find(g => g.id === $("#lien-groupe").value);
  const source = groupes.find(g => g.id === lienEdite.groupeId);
  if (lienEdite.lienId) {
    const i = source.liens.findIndex(l => l.id === lienEdite.lienId);
    const lien = { ...source.liens[i], nom, url };
    if (cible === source) source.liens[i] = lien;
    else { source.liens.splice(i, 1); cible.liens.push(lien); }
  } else {
    cible.liens.push({ id: id(), nom, url });
  }
  enregistrer({ groupes });
  rendreGroupes();
});
$("#lien-supprimer").addEventListener("click", () => {
  const g = groupes.find(g => g.id === lienEdite.groupeId);
  g.liens = g.liens.filter(l => l.id !== lienEdite.lienId);
  lienEdite = null;
  $("#dlg-lien").close();
  enregistrer({ groupes });
  rendreGroupes();
  toast("Raccourci supprimé");
});

/* Fenêtre cartouche */
let groupeEdite = null;
function ouvrirDlgGroupe(groupeId) {
  groupeEdite = groupeId;
  const g = groupeId ? groupes.find(g => g.id === groupeId) : null;
  $("#dlg-groupe-titre").textContent = g ? "Modifier la cartouche" : "Nouvelle cartouche";
  $("#groupe-nom").value = g ? g.nom : "";
  $("#groupe-couleur").value = g ? g.couleur : "rouge";
  $("#groupe-supprimer").hidden = !g;
  $("#dlg-groupe").returnValue = "";
  $("#dlg-groupe").showModal();
}
$("#btn-ajout-groupe").addEventListener("click", () => ouvrirDlgGroupe(null));
$("#dlg-groupe").addEventListener("close", () => {
  if ($("#dlg-groupe").returnValue !== "ok") return;
  const nom = $("#groupe-nom").value.trim();
  const couleur = $("#groupe-couleur").value;
  if (groupeEdite) Object.assign(groupes.find(g => g.id === groupeEdite), { nom, couleur });
  else groupes.push({ id: id(), nom, couleur, liens: [] });
  enregistrer({ groupes });
  rendreGroupes();
});
$("#groupe-supprimer").addEventListener("click", () => {
  const g = groupes.find(g => g.id === groupeEdite);
  if (g.liens.length && !confirm(`Supprimer « ${g.nom} » et ses ${g.liens.length} liens ?`)) return;
  groupes = groupes.filter(x => x.id !== groupeEdite);
  $("#dlg-groupe").close();
  enregistrer({ groupes });
  rendreGroupes();
});

/* ---------- Tâches ---------- */
function rendreTaches() {
  const ul = $("#liste-taches");
  ul.innerHTML = "";
  if (!taches.length) {
    ul.innerHTML = `<li class="vide">Rien pour l'instant. Profites-en pour dessiner !</li>`;
  }
  for (const t of taches) {
    const li = document.createElement("li");
    li.className = "tache" + (t.faite ? " faite" : "");
    li.innerHTML = `<input type="checkbox" ${t.faite ? "checked" : ""} aria-label="Fait"><span>${echapper(t.t)}</span><button title="Supprimer">✕</button>`;
    li.querySelector("input").addEventListener("change", e => {
      t.faite = e.target.checked;
      if (t.faite && taches.every(x => x.faite)) toast("Tout est fait, bravo ! 🎉");
      majTaches();
    });
    li.querySelector("button").addEventListener("click", () => {
      taches = taches.filter(x => x !== t);
      majTaches();
    });
    ul.appendChild(li);
  }
  $("#btn-vider-taches").hidden = !taches.some(t => t.faite);
}
function majTaches() { enregistrer({ taches }); rendreTaches(); majHorloge(); }

$("#form-tache").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("#champ-tache").value.trim();
  if (!v) return;
  taches.push({ id: id(), t: v, faite: false });
  $("#champ-tache").value = "";
  majTaches();
});
$("#btn-vider-taches").addEventListener("click", () => {
  taches = taches.filter(t => !t.faite);
  majTaches();
});

/* ---------- Devis express ---------- */
const euros = n => n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " €";
function majDevis() {
  const h = parseFloat($("#devis-heures").value) || 0;
  const taux = parseFloat($("#devis-taux").value) || 0;
  $("#devis-prix").textContent = euros(h * taux);

  const f = parseFloat($("#devis-forfait").value);
  const out = $("#devis-budget");
  if (f > 0 && taux > 0) {
    const heures = f / taux;
    const hh = Math.floor(heures);
    const mm = Math.round((heures - hh) * 60);
    out.textContent = `${hh} h${mm ? String(mm).padStart(2, "0") : ""} de travail`;
    out.classList.remove("attente");
  } else {
    out.textContent = "budget d'heures";
    out.classList.add("attente");
  }
}
["#devis-heures", "#devis-forfait"].forEach(s => $(s).addEventListener("input", majDevis));
$("#devis-taux").addEventListener("input", () => {
  R.taux = parseFloat($("#devis-taux").value) || 0;
  enregistrer({ reglages: R });
  majDevis();
});
$("#devis-prix").addEventListener("click", () => copier($("#devis-prix").textContent));

/* ---------- Astuce du jour ---------- */
function jourDeLAnnee() {
  const d = new Date();
  return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}
function rendreAstuce() {
  const liste = window.ASTUCES || [];
  if (!liste.length) return;
  const a = liste[((astuceIndex % liste.length) + liste.length) % liste.length];
  $("#astuce-texte").textContent = a.t;
  const tag = $("#astuce-tag");
  tag.textContent = a.tag === "google" ? "Google" : a.tag === "portfolio" ? "Portfolio" : "Instagram";
  tag.className = "tag " + a.tag;
}
$("#btn-astuce-suivante").addEventListener("click", () => { astuceIndex++; rendreAstuce(); });

/* ---------- Notes ---------- */
let notesMinuteur;
$("#notes").addEventListener("input", () => {
  $("#notes-etat").textContent = "…";
  clearTimeout(notesMinuteur);
  notesMinuteur = setTimeout(() => {
    enregistrer({ notes: $("#notes").value });
    $("#notes-etat").textContent = "Enregistré ✓";
  }, 400);
});

/* ---------- Palette ---------- */
async function copier(texte) {
  try { await navigator.clipboard.writeText(texte); toast(`${texte} copié !`); }
  catch { toast("Copie impossible"); }
}
function rendrePalette() {
  $("#palette").innerHTML = "";
  for (const c of PALETTE) {
    const b = document.createElement("button");
    b.className = "pastille-couleur";
    b.style.background = c.hex;
    b.style.color = c.texte;
    b.title = `${c.nom} ${c.hex}`;
    b.textContent = c.hex.slice(1);
    b.addEventListener("click", () => copier(c.hex));
    $("#palette").appendChild(b);
  }
}

/* ---------- Météo (Open-Meteo, gratuit, sans compte) ---------- */
const METEO_CODES = [
  [[0], "☀️", "Grand soleil"], [[1, 2], "🌤️", "Quelques nuages"], [[3], "☁️", "Couvert"],
  [[45, 48], "🌫️", "Brouillard"], [[51, 53, 55, 56, 57], "🌦️", "Bruine"],
  [[61, 63, 65, 66, 67, 80, 81, 82], "🌧️", "Pluie"], [[71, 73, 75, 77, 85, 86], "❄️", "Neige"],
  [[95, 96, 99], "⛈️", "Orage"]
];
async function majMeteo() {
  const el = $("#meteo");
  if (!R.ville) { el.hidden = true; return; }
  try {
    const { meteoCache } = await stock.lire(["meteoCache"]);
    let c = meteoCache;
    if (!c || c.ville !== R.ville || Date.now() - c.quand > 30 * 60 * 1000) {
      let lat = c && c.ville === R.ville ? c.lat : null;
      let lon = c && c.ville === R.ville ? c.lon : null;
      let nomVille = c && c.ville === R.ville ? c.nomVille : R.ville;
      if (lat === null) {
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=fr&name=${encodeURIComponent(R.ville)}`).then(r => r.json());
        if (!g.results || !g.results.length) { el.hidden = false; el.textContent = "Ville introuvable"; return; }
        ({ latitude: lat, longitude: lon, name: nomVille } = g.results[0]);
      }
      const m = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`).then(r => r.json());
      c = { ville: R.ville, nomVille, lat, lon, quand: Date.now(), temp: m.current.temperature_2m, code: m.current.weather_code };
      enregistrer({ meteoCache: c });
    }
    const [, emoji, libelle] = METEO_CODES.find(([codes]) => codes.includes(c.code)) || [[], "🌡️", ""];
    el.innerHTML = `${emoji} <strong>${Math.round(c.temp)}°</strong> <span class="ville">${echapper(c.nomVille)}</span>`;
    el.title = libelle;
    el.hidden = false;
  } catch {
    el.hidden = true;
  }
}

/* ---------- Réglages ---------- */
$("#btn-reglages").addEventListener("click", () => {
  $("#reg-prenom").value = R.prenom || "";
  $("#reg-taux").value = R.taux;
  $("#reg-ville").value = R.ville || "";
  $("#dlg-reglages").returnValue = "";
  $("#dlg-reglages").showModal();
});
$("#dlg-reglages").addEventListener("close", () => {
  if ($("#dlg-reglages").returnValue !== "ok") return;
  R.prenom = $("#reg-prenom").value.trim();
  R.taux = parseFloat($("#reg-taux").value) || 0;
  R.ville = $("#reg-ville").value.trim();
  enregistrer({ reglages: R });
  $("#devis-taux").value = R.taux;
  majDevis();
  majHorloge();
  majMeteo();
  toast("Réglages enregistrés");
});

$("#btn-export").addEventListener("click", async () => {
  const data = await stock.tout();
  delete data.meteoCache;
  const blob = new Blob([JSON.stringify({ app: "phant-accueil", version: 1, data }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `phant-accueil-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("Sauvegarde téléchargée");
});
$("#fichier-import").addEventListener("change", async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    if (json.app !== "phant-accueil" || !json.data) throw new Error();
    await stock.ecrire(json.data);
    $("#dlg-reglages").close();
    await charger();
    toast("Sauvegarde importée ✓");
  } catch {
    toast("Ce fichier n'est pas une sauvegarde valide");
  }
  e.target.value = "";
});
$("#btn-reinit").addEventListener("click", async () => {
  if (!confirm("Tout effacer (raccourcis, notes, tâches, réglages) et revenir à la version de départ ?")) return;
  await stock.vider();
  $("#dlg-reglages").close();
  await charger();
  toast("Remis à zéro");
});

/* ---------- Petit clin d'œil console ---------- */
const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
let konamiPos = 0;
function fete() {
  const on = document.body.classList.toggle("fete");
  $("#pied-texte").textContent = on ? "PLAYER 1 READY" : "PRESS START";
  if (on) toast("🎮 Mode fête activé");
}
document.addEventListener("keydown", e => {
  if (e.target.matches("input, textarea")) return;
  konamiPos = e.key === KONAMI[konamiPos] ? konamiPos + 1 : (e.key === KONAMI[0] ? 1 : 0);
  if (konamiPos === KONAMI.length) { konamiPos = 0; fete(); }
});
$("#pied-texte").addEventListener("dblclick", fete);

/* ---------- Synchro entre onglets ouverts ---------- */
if (enExtension && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((chg, zone) => {
    if (zone !== "local") return;
    if (chg.groupes && chg.groupes.newValue) { groupes = chg.groupes.newValue; rendreGroupes(); }
    if (chg.taches && chg.taches.newValue) { taches = chg.taches.newValue; rendreTaches(); majHorloge(); }
    if (chg.notes && document.activeElement !== $("#notes")) $("#notes").value = chg.notes.newValue || "";
  });
}

/* ---------- Chargement ---------- */
async function charger() {
  const d = await stock.lire(["reglages", "groupes", "taches", "notes"]);
  R = { ...REGLAGES_DEFAUT, ...(d.reglages || {}) };
  groupes = Array.isArray(d.groupes) ? d.groupes : groupesDepuisDefaut();
  taches = Array.isArray(d.taches) ? d.taches : [];
  if (!d.groupes) enregistrer({ groupes });

  appliquerMode();
  rendreMoteurs();
  rendreGroupes();
  rendreTaches();
  rendrePalette();
  $("#notes").value = d.notes || "";
  $("#devis-taux").value = R.taux;
  majDevis();
  astuceIndex = jourDeLAnnee();
  rendreAstuce();
  majHorloge();
  majMeteo();
}

charger();

/* Version web : fonctionne hors connexion une fois installée */
if (!enExtension && "serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
setInterval(majHorloge, 1000 * 10);
