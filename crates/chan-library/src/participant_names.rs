//! Participant default-name generation from a Tupi-Guarani wordlist with
//! collision avoidance.
//!
//! Every session participant is assigned a generated default display name at
//! join, so a roster row never renders empty: the snapshot precedence chain
//! in [`session_presence`](crate::session_presence) (rename override >
//! gateway identity > generated default) bottoms out here. Base words come
//! from the wordlist; when all are taken the generator mutates 1-2 vowels,
//! and as a last resort appends a numeric suffix, so [`generate_name`] never
//! fails. The caller supplies the taken set (the tenant registry's names in
//! play); the generator holds no state of its own.

use std::collections::HashSet;

use rand::seq::SliceRandom;
use rand::Rng;

use crate::name_casefold::comparison_key;

const VOWELS: &[u8] = b"aeiou";

/// Variations of Tupi-Guarani words and names used for default-name
/// generation.
const WORDLIST: &[&str] = &[
    "tinguituguassu",
    "guarueguaguara",
    "juruiuimatuba",
    "tucarabaranga",
    "pirauemaranga",
    "pacaucajupara",
    "acajuucaguara",
    "curiguaracaba",
    "umuaguarapura",
    "sapiumadidaba",
    "indakuibicaba",
    "tucarucuguata",
    "umuabanapira",
    "janditibaobi",
    "juruatomoiru",
    "paraoraranga",
    "jabaumaromba",
    "botoibiquara",
    "sapipoibaipa",
    "mbiraebupore",
    "jataguataaca",
    "indaomiriari",
    "mucuquaranda",
    "votupumbioca",
    "caraiuubagui",
    "botoitubaira",
    "jabagoacuque",
    "acajuonhandu",
    "mbirarabaibi",
    "iporainhaaru",
    "jatangutinga",
    "juruetutaemu",
    "iporaquaanha",
    "birakingunda",
    "jataicaruacu",
    "umuaicakonha",
    "jurutibapuru",
    "nitecabadaba",
    "corookuvunda",
    "tabairudimba",
    "ndaraanhaemu",
    "angaringaqua",
    "jabaangarema",
    "pacanearaaca",
    "tingutibaiti",
    "indabanaidi",
    "carannguatu",
    "mboamamaeca",
    "umuajaviaru",
    "mogikeuiavu",
    "jatavoguara",
    "sapiobameja",
    "iporaatumbu",
    "nhanjaituji",
    "macavaarisi",
    "puricabaeia",
    "tupiuimuura",
    "anhacabaaca",
    "guaraguaque",
    "iporanhaacu",
    "catuitutiba",
    "piraugianga",
    "tiriutupore",
    "capoarapaja",
    "guarparaoca",
    "jacutuabaka",
    "maranhopore",
    "tupiruumaui",
    "botoirasare",
    "jatatingacu",
    "pirauracusu",
    "maranequara",
    "mandiibooba",
    "camuiparaba",
    "jatatibaaba",
    "macaemarema",
    "mandiimaita",
    "botutubandu",
    "piraubaanga",
    "tingugocema",
    "paraipatasa",
    "sapidabaama",
    "indauaroori",
    "umuaacaieko",
    "tapuonhaibo",
    "piruipemana",
    "guarameieco",
    "curinhetaba",
    "umuatujuacu",
    "capoquarami",
    "macanemagui",
    "miriguimuco",
    "iporakepaba",
    "pacairuinga",
    "juruauraati",
    "tapimutinga",
    "juruacemaki",
    "caranataacu",
    "maraemanavi",
    "tabanuconda",
    "guaiingaura",
    "murucabamba",
    "tucabokanda",
    "capivukuiti",
    "acannuoraua",
    "botuumacara",
    "indajiringa",
    "nitemitinga",
    "mandiboiaga",
    "guaratibaua",
    "caranjeeacu",
    "guarateruca",
    "maracabaiba",
    "tamaassuacu",
    "jabarangamo",
    "caranmubite",
    "miritiquara",
    "tupicuabaki",
    "mirijutuba",
    "caraemaetu",
    "capouarumi",
    "ubagonhivo",
    "puritibadi",
    "sapinocuru",
    "niteiboeia",
    "botutubaca",
    "catuibiitu",
    "anhandaiae",
    "sapiemaiee",
    "niteecumbu",
    "jabaeianhe",
    "iporairiji",
    "curiicaiie",
    "ubaurarema",
    "jataemaque",
    "curiguassu",
    "itaocapira",
    "ibicaranga",
    "jacutibaco",
    "nhankoiumi",
    "macaipeoba",
    "miritaunga",
    "ibiguguara",
    "ipaneubaje",
    "capooimame",
    "ubabeatuua",
    "tinguguaki",
    "nitenuassu",
    "acajundiiu",
    "jagudupora",
    "acajuvonga",
    "guaiaeiati",
    "juruguinga",
    "pirapigovi",
    "turiecuoba",
    "sapiassusa",
    "ndaravaoke",
    "umuaacaaga",
    "caramanape",
    "araciubaia",
    "nhanacaira",
    "apiravuibi",
    "caporetume",
    "tapumanaci",
    "caratabaua",
    "capopuruni",
    "niteingava",
    "pindaetuma",
    "paraatauia",
    "guaracubea",
    "purijaueji",
    "jacudituba",
    "capombuuba",
    "turiungapu",
    "sapietunga",
    "carabaracu",
    "tapiimambu",
    "jucaecaema",
    "itaonhanoe",
    "jabamutuba",
    "capobapora",
    "jacuuraica",
    "tucaangaga",
    "jeriocauba",
    "guartipore",
    "mboaemaama",
    "puringaibo",
    "murueiaecu",
    "indapurucu",
    "juruameeca",
    "iporajaipa",
    "pirukidaba",
    "jerinhouma",
    "piratabavo",
    "aramoabaro",
    "tabacemape",
    "niteiboqua",
    "mandiamako",
    "juruajaara",
    "capoobaiti",
];

/// Change 1-2 vowels of `word` to different vowels, leaving consonants and
/// length untouched. A word without vowels (not in the wordlist) is returned
/// unchanged; the caller's numeric-suffix fallback covers it.
fn mutate_vowels(rng: &mut impl Rng, word: &str) -> String {
    let bytes = word.as_bytes();
    let vowel_positions: Vec<usize> = bytes
        .iter()
        .enumerate()
        .filter(|(_, &b)| VOWELS.contains(&b))
        .map(|(i, _)| i)
        .collect();
    if vowel_positions.is_empty() {
        return word.to_string();
    }

    let mut result = bytes.to_vec();

    // Pick how many vowels to change: 1 or 2.
    let count = if vowel_positions.len() == 1 {
        1
    } else {
        rng.gen_range(1..=2)
    };

    // Fisher-Yates partial shuffle to pick `count` positions.
    let mut positions = vowel_positions;
    for i in 0..count.min(positions.len()) {
        let j = i + rng.gen_range(0..positions.len() - i);
        positions.swap(i, j);
    }

    for &pos in &positions[..count.min(positions.len())] {
        let current = result[pos];
        // Pick a different vowel.
        let mut new_vowel = VOWELS[rng.gen_range(0..VOWELS.len())];
        while new_vowel == current {
            new_vowel = VOWELS[rng.gen_range(0..VOWELS.len())];
        }
        result[pos] = new_vowel;
    }

    String::from_utf8(result).expect("vowel mutation preserves ascii")
}

/// Generate a default participant name distinct ignoring case from `taken`.
/// Never fails: shuffled base words first, then vowel mutations, then a
/// numeric suffix (the taken set is a handful of participants, so exhaustion
/// is not a real case, but the fallback keeps the guarantee unconditional).
pub fn generate_name(taken: &HashSet<String>) -> String {
    // Every generated candidate is lowercase ASCII, already a comparison key.
    let taken: HashSet<_> = taken.iter().map(|name| comparison_key(name)).collect();
    let mut rng = rand::thread_rng();
    let mut words: Vec<&str> = WORDLIST.to_vec();
    words.shuffle(&mut rng);

    // Try each base word.
    for word in &words {
        if !taken.contains(*word) {
            return (*word).to_string();
        }
    }

    // All base words taken; try vowel mutations.
    for _ in 0..200 {
        let base = words[rng.gen_range(0..words.len())];
        let mutated = mutate_vowels(&mut rng, base);
        if !taken.contains(&mutated) {
            return mutated;
        }
    }

    // Mutations exhausted too; a numeric suffix always terminates.
    let base = words[0];
    let mut n = 2u64;
    loop {
        let candidate = format!("{base}{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naming_repair_generation_reserves_caseless_effective_names() {
        let taken = WORDLIST.iter().map(|name| name.to_uppercase()).collect();
        let name = generate_name(&taken);
        assert_eq!(WORDLIST.iter().filter(|word| **word == name).count(), 0);
    }

    #[test]
    fn wordlist_is_lowercase_ascii_and_duplicate_free() {
        assert_eq!(WORDLIST.len(), 200, "expected 200 words in wordlist");
        let mut seen = HashSet::new();
        for word in WORDLIST {
            assert!(
                !word.is_empty() && word.bytes().all(|b| b.is_ascii_lowercase()),
                "word not lowercase ascii: {word}"
            );
            assert!(seen.insert(*word), "duplicate word: {word}");
        }
    }

    #[test]
    fn generates_a_base_word_when_nothing_is_taken() {
        let name = generate_name(&HashSet::new());
        assert!(
            WORDLIST.contains(&name.as_str()),
            "name should be from the wordlist"
        );
    }

    #[test]
    fn avoids_taken_names() {
        let taken: HashSet<String> = WORDLIST[..5].iter().map(|w| w.to_string()).collect();
        for _ in 0..20 {
            let name = generate_name(&taken);
            assert!(!taken.contains(&name), "returned a taken name: {name}");
        }
    }

    #[test]
    fn falls_back_to_mutation_when_all_base_words_are_taken() {
        let taken: HashSet<String> = WORDLIST.iter().map(|w| w.to_string()).collect();
        let name = generate_name(&taken);
        assert!(!taken.contains(&name));
        assert!(
            !WORDLIST.contains(&name.as_str()),
            "name should be a mutation, not a base word"
        );
        assert!(name.bytes().all(|b| b.is_ascii_lowercase()));
    }

    #[test]
    fn mutation_changes_only_vowels_and_preserves_length() {
        let mut rng = rand::thread_rng();
        let word = "tinguituguassu";
        for _ in 0..10 {
            let mutated = mutate_vowels(&mut rng, word);
            assert_ne!(mutated, word, "mutation should differ from input");
            assert_eq!(mutated.len(), word.len(), "length should be preserved");
            for (i, (a, b)) in word.bytes().zip(mutated.bytes()).enumerate() {
                if !VOWELS.contains(&a) {
                    assert_eq!(a, b, "consonant at position {i} changed");
                }
            }
        }
    }

    #[test]
    fn sequential_draws_stay_unique() {
        // The join-time contract: each new participant draws against the
        // names in play, and two windows never share a generated name.
        let mut taken = HashSet::new();
        for _ in 0..300 {
            let name = generate_name(&taken);
            assert!(!name.is_empty());
            assert!(taken.insert(name), "generated a name already in the set");
        }
    }
}
