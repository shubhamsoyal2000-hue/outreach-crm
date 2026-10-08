export type CompanyKind = "importer" | "forwarder" | "carrier" | "other";

/** Forwarders, NVOCCs and customs brokers that show up in a broker's mail but whose domain doesn't say so. */
const KNOWN_FORWARDERS = new Set([
  "jas.com", "kln.com", "bdpint.com", "flexport.com", "kwe.com", "scangl.com", "shipco.com", "cubeship.com", "fracht.com", "scanwell.com",
  "unicologx.com", "dbschenker.com", "kuehne-nagel.com", "hillebrandgori.com", "sankyu.co.jp", "axiomwwl.com", "efl.global", "cevalogistics.com",
  "expeditors.com", "dhl.com", "dsv.com", "nipponexpress.com", "yusen-logistics.com", "agility.com", "geodis.com", "bollore.com", "craneww.com",
  "hellmann.com", "rhenus.com", "seko.com", "dimerco.com", "ecuworldwide.com", "vanguardlogistics.com", "nnrglobal.com", "hecny.com",
  "topocean.com", "oecgroup.com", "pglus.com", "otsusa.com", "ilsinc.net", "molgroup.com", "szvif.com", "apexglobe.com", "pantos.com",
  "sinotrans.com", "toll.com.au", "chrobinson.com", "damco.com", "maersk.com", "ups.com", "fedex.com", "cargoservices.com", "trans-group.com",
  "binexline.com", "emotrans.com", "alpiusa.com", "awotglobal.com", "cnlglobal.com", "scarbroughglobal.com", "mslcorporate.com", "wnepstein.com",
  "caribetrans.com", "coleintl.com", "corbettintl.com", "howardsreederinc.com", "rslog.com", "dcintlus.com", "radiantdelivers.com",
  "rutherfordglobal.com", "savinodelbene.com", "teamww.com", "yqn.com", "airgroup.com", "efwnow.com", "interglobo.com", "livingstonintl.com",
  "oecgroup.ca", "rohlig.com", "shapiro.com", "kerrylogistics.com", "ctsi-global.com", "apllogistics.com", "pilotdelivers.com",
]);
const KNOWN_CARRIERS = new Set(["roadone.com", "jbhunt.com", "schneider.com", "knight-swift.com", "matson.com", "msc.com", "cma-cgm.com", "one-line.com", "hapag-lloyd.com", "evergreen-line.com", "cosco.com", "zim.com", "yangming.com", "hmm21.com", "oocl.com"]);

const FORWARDER_WORDS = /(logistic|logistik|freight|fracht|shipping|cargo|forward|maritime|ocean|customs|broker|consolidat|supplychain|supply-chain|express|worldwide|wwl\b|scm\b)/;
/** Names ending like "...global", "...intl", "...trans", "...log", "...ww" are nearly always forwarders or brokers. */
const FORWARDER_ENDINGS = /(global|intl|intlus|trans|log|ww|wwl)$/;
const CARRIER_WORDS = /(trucking|truckline|freightline|transport|hauling|cartage|drayage|carrier)/;

/** Rough type from the website domain; the team can correct it on the company. */
export function guessCompanyKind(domain: string | null | undefined): CompanyKind {
  if (!domain) return "importer";
  const d = domain.toLowerCase();
  const root = d.split(".").slice(-2).join(".");
  if (/\.(gov|mil)$/.test(d)) return "other";
  if (KNOWN_FORWARDERS.has(d) || KNOWN_FORWARDERS.has(root)) return "forwarder";
  if (KNOWN_CARRIERS.has(d) || KNOWN_CARRIERS.has(root)) return "carrier";
  const label = d.split(".").slice(0, -1).join(".");
  if (FORWARDER_WORDS.test(label) || FORWARDER_ENDINGS.test(label)) return "forwarder";
  if (CARRIER_WORDS.test(label)) return "carrier";
  return "importer";
}
