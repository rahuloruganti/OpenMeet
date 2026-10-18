//! Local keyword retrieval for questions about content too long for one request.
//! Everything here is pure and runs on this device; only the selected excerpts are ever sent.
use crate::domain::ExcerptSummary;
use std::collections::BTreeSet;

const MAX_TERMS: usize = 12;
/// Transcript lines kept on each side of a matching line.
const NEIGHBOURS: usize = 2;
/// Most matching transcript lines considered per question.
pub const MAX_HITS: usize = 100;
/// Marks skipped transcript between two excerpts.
const GAP: &str = "…";

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was",
    "one", "our", "out", "has", "have", "him", "his", "how", "its", "may", "who", "did", "get",
    "got", "let", "say", "she", "too", "use", "what", "when", "where", "which", "why", "with",
    "this", "that", "these", "those", "there", "their", "them", "then", "than", "they", "from",
    "about", "does", "were", "will", "would", "could", "should", "been", "being", "into", "your",
    "some", "such", "also", "just", "over", "only", "very", "more", "most", "other", "said",
    "tell", "talk", "meeting", "meetings",
];

/// Lowercase letter/digit words of the question, minus short words and stopwords, deduplicated.
pub fn terms(question: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for word in question.split(|c: char| !c.is_alphanumeric()) {
        let word = word.to_lowercase();
        if word.chars().count() >= 3
            && !STOPWORDS.contains(&word.as_str())
            && !found.contains(&word)
        {
            found.push(word);
            if found.len() == MAX_TERMS {
                break;
            }
        }
    }
    found
}

/// An FTS5 query over the `body` column. Every term is a quoted string, so user text can
/// never become FTS5 syntax (operators, column filters, prefix stars).
pub fn fts_query(terms: &[String]) -> Option<String> {
    if terms.is_empty() {
        return None;
    }
    let quoted: Vec<String> = terms
        .iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect();
    Some(format!("body : ({})", quoted.join(" OR ")))
}

fn mentions(text: &str, terms: &[String]) -> bool {
    let text = text.to_lowercase();
    terms.iter().any(|term| text.contains(term.as_str()))
}

/// The notes to send in excerpt mode: nothing when they mention no term; all of them when
/// they fit `share`; otherwise only the paragraphs that mention a term, in order.
pub fn notes_excerpt(notes: &str, terms: &[String], share: usize) -> String {
    if !mentions(notes, terms) {
        return String::new();
    }
    if notes.len() <= share {
        return notes.to_string();
    }
    let mut kept = String::new();
    for paragraph in notes.replace("\r\n", "\n").split("\n\n") {
        let cost = paragraph.len() + if kept.is_empty() { 0 } else { 2 };
        if mentions(paragraph, terms) && kept.len() + cost <= share {
            if !kept.is_empty() {
                kept.push_str("\n\n");
            }
            kept.push_str(paragraph);
        }
    }
    kept
}

/// Chooses transcript lines: each hit (meeting index, line index), best first, brings its
/// neighbours, until `budget` bytes are used. `sizes` are the byte lengths of every
/// meeting's lines. A hit whose lines no longer fit is skipped, so no line is ever cut.
pub fn select(
    hits: &[(usize, usize)],
    sizes: &[Vec<usize>],
    mut budget: usize,
) -> Vec<BTreeSet<usize>> {
    let mut chosen = vec![BTreeSet::new(); sizes.len()];
    for &(meeting, hit) in hits {
        let lines = &sizes[meeting];
        if hit >= lines.len() {
            continue;
        }
        let window = hit.saturating_sub(NEIGHBOURS)..(hit + NEIGHBOURS + 1).min(lines.len());
        let cost: usize = window
            .clone()
            .filter(|line| !chosen[meeting].contains(line))
            .map(|line| lines[line] + 1)
            .sum();
        if cost <= budget {
            budget -= cost;
            chosen[meeting].extend(window);
        }
    }
    chosen
}

/// The chosen lines in transcript order, with a gap marker wherever lines were skipped.
pub fn excerpt_lines(lines: &[String], chosen: &BTreeSet<usize>) -> Vec<String> {
    let mut out = Vec::new();
    let mut previous: Option<usize> = None;
    for &line in chosen {
        if previous.is_some_and(|before| before + 1 != line) {
            out.push(GAP.to_string());
        }
        out.push(lines[line].clone());
        previous = Some(line);
    }
    out
}

pub fn summary(chosen: &[BTreeSet<usize>]) -> ExcerptSummary {
    ExcerptSummary {
        segments: chosen.iter().map(BTreeSet::len).sum(),
        meetings: chosen.iter().filter(|set| !set.is_empty()).count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn terms_drop_short_words_and_stopwords_and_cap() {
        assert_eq!(
            terms("What is the Launch budget? The BUDGET, 40k; to go"),
            words(&["launch", "budget", "40k"])
        );
        let many = (0..30)
            .map(|n| format!("word{n}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(terms(&many).len(), MAX_TERMS);
        assert!(terms("is it a to of").is_empty());
    }

    #[test]
    fn fts_query_quotes_every_term_and_doubles_embedded_quotes() {
        assert_eq!(fts_query(&[]), None);
        assert_eq!(
            fts_query(&words(&["launch", "a\"b", "NEAR", "x*"])).unwrap(),
            "body : (\"launch\" OR \"a\"\"b\" OR \"NEAR\" OR \"x*\")"
        );
        // Words from a hostile question stay quoted text.
        let hostile = terms("budget\" OR body:secret* NOT (x) -y");
        let query = fts_query(&hostile).unwrap();
        assert!(query.starts_with("body : (\"budget\" OR "));
        assert!(!query.contains('*') && !query.contains("NOT"));
    }

    #[test]
    fn notes_are_sent_whole_when_they_fit_else_only_matching_paragraphs() {
        let terms = words(&["launch"]);
        assert_eq!(notes_excerpt("nothing here", &terms, 100), "");
        assert_eq!(
            notes_excerpt("The Launch is Friday", &terms, 100),
            "The Launch is Friday"
        );
        let notes = "intro\n\nlaunch one\n\nunrelated filler text\n\nLaunch two";
        assert_eq!(notes_excerpt(notes, &terms, 30), "launch one\n\nLaunch two");
        assert_eq!(notes_excerpt(notes, &terms, 12), "launch one");
    }

    #[test]
    fn selection_adds_neighbours_merges_overlaps_and_respects_the_budget() {
        let sizes = vec![vec![10; 10], vec![10; 3]];
        // Hit 4 brings 2..=6; hit 6 overlaps and adds only 7 and 8.
        let chosen = select(&[(0, 4), (0, 6)], &sizes, 1_000);
        assert_eq!(
            chosen[0].iter().copied().collect::<Vec<_>>(),
            (2..=8).collect::<Vec<_>>()
        );
        assert!(chosen[1].is_empty());
        // 11 bytes per line: the first window costs 55, so neither later window fits in 60.
        let chosen = select(&[(0, 2), (0, 8), (1, 1)], &sizes, 60);
        assert_eq!(chosen[0].len(), 5);
        assert!(chosen[0].contains(&0) && !chosen[0].contains(&9));
        assert!(
            chosen[1].is_empty(),
            "a window that does not fit is skipped whole"
        );
        // Out-of-range hits are ignored.
        assert!(select(&[(0, 99)], &sizes, 1_000)[0].is_empty());
        assert_eq!(
            summary(&select(&[(0, 1), (1, 1)], &sizes, 1_000)).meetings,
            2
        );
    }

    #[test]
    fn excerpts_keep_order_and_mark_gaps() {
        let lines = words(&["a", "b", "c", "d", "e", "f"]);
        let chosen: BTreeSet<usize> = [0, 1, 4, 5].into();
        assert_eq!(
            excerpt_lines(&lines, &chosen),
            words(&["a", "b", GAP, "e", "f"])
        );
    }
}
