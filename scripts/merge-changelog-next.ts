#!/usr/bin/env bun
/**
 * Merge fork-local CHANGELOG.next files into their package's CHANGELOG.md.
 *
 * Why this exists: this repo is a long-lived fork that rebases onto upstream.
 * Writing fork-local entries directly into CHANGELOG.md causes mechanical
 * conflicts on every rebase (upstream also edits the same [Unreleased] section).
 * CHANGELOG.next keeps fork entries in a separate file that never conflicts.
 *
 * This script is called by `scripts/release.ts` (updateChangelogsForRelease)
 * before the [Unreleased] → version-heading rename, so fork entries land in
 * the released section. It can also be run standalone.
 *
 * Behavior:
 *   - For each package's CHANGELOG.next that exists and has content:
 *       1. Parse its ### subsections.
 *       2. Merge them into CHANGELOG.md's [Unreleased] section, preserving
 *          the canonical section order (Breaking Changes, Added, Changed,
 *          Fixed, Removed). Existing subsections are appended to; new ones
 *          are created in-order.
 *       3. Clear CHANGELOG.next to a header-only stub.
 *   - Packages without a CHANGELOG.next are skipped.
 *   - Idempotent: re-running with an already-cleared .next is a no-op.
 */
import { Glob } from "bun";

const PACKAGE_ROOT = ".";
const NEXT_GLOB = "packages/*/CHANGELOG.next";
const ORDERED_SECTIONS = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"] as const;

interface Subsection {
	title: string;
	lines: string[]; // body lines (excluding the ### heading)
}

function sectionRank(title: string): number {
	const idx = ORDERED_SECTIONS.indexOf(title as (typeof ORDERED_SECTIONS)[number]);
	return idx === -1 ? ORDERED_SECTIONS.length : idx;
}

/**
 * Parse the body of a CHANGELOG.next file into titled subsections.
 * Lines before the first ### heading are treated as comments and skipped.
 */
function parseNextSections(content: string): Subsection[] {
	const lines = content.split("\n");
	const sections: Subsection[] = [];
	let current: Subsection | null = null;

	for (const line of lines) {
		const headingMatch = line.match(/^###\s+(.+)$/);
		if (headingMatch) {
			current = { title: headingMatch[1].trim(), lines: [] };
			sections.push(current);
			continue;
		}
		if (current) {
			current.lines.push(line);
		}
	}

	// Trim trailing blank lines from each subsection
	for (const s of sections) {
		while (s.lines.length > 0 && s.lines[s.lines.length - 1].trim() === "") {
			s.lines.pop();
		}
	}

	// Drop empty subsections
	return sections.filter(s => s.lines.some(l => l.trim() !== ""));
}

/**
 * Find the [Unreleased] section boundary in CHANGELOG.md.
 * Returns [startIdx, endIdx) line indices (endExclusive = start of next ## heading or EOF).
 */
function findUnreleasedRange(changelogLines: string[]): [number, number] | null {
	const unreleasedIdx = changelogLines.findIndex(l => /^## \[Unreleased\]/.test(l));
	if (unreleasedIdx === -1) return null;

	// Find the next ## heading after [Unreleased]
	let endIdx = changelogLines.length;
	for (let i = unreleasedIdx + 1; i < changelogLines.length; i++) {
		if (/^##\s/.test(changelogLines[i])) {
			endIdx = i;
			break;
		}
	}
	return [unreleasedIdx, endIdx];
}

/**
 * Parse subsections from the [Unreleased] range of CHANGELOG.md.
 */
function parseExistingSubsections(lines: string[], start: number, end: number): Subsection[] {
	const sections: Subsection[] = [];
	let current: Subsection | null = null;

	for (let i = start + 1; i < end; i++) {
		const line = lines[i];
		const headingMatch = line.match(/^###\s+(.+)$/);
		if (headingMatch) {
			current = { title: headingMatch[1].trim(), lines: [] };
			sections.push(current);
		} else if (current) {
			current.lines.push(line);
		}
	}

	for (const s of sections) {
		while (s.lines.length > 0 && s.lines[s.lines.length - 1].trim() === "") {
			s.lines.pop();
		}
	}
	return sections;
}

function mergeSubsections(existing: Subsection[], incoming: Subsection[]): Subsection[] {
	const byTitle = new Map<string, Subsection>();
	for (const s of existing) {
		byTitle.set(s.title, { title: s.title, lines: [...s.lines] });
	}

	for (const inc of incoming) {
		const ex = byTitle.get(inc.title);
		if (ex) {
			// Append with a blank separator if needed
			if (ex.lines.length > 0 && ex.lines[ex.lines.length - 1].trim() !== "") {
				ex.lines.push("");
			}
			ex.lines.push(...inc.lines);
		} else {
			byTitle.set(inc.title, { title: inc.title, lines: [...inc.lines] });
		}
	}

	return [...byTitle.values()].sort((a, b) => {
		const ra = sectionRank(a.title);
		const rb = sectionRank(b.title);
		if (ra !== rb) return ra - rb;
		return a.title.localeCompare(b.title);
	});
}

function renderUnreleasedBody(sections: Subsection[]): string {
	const parts: string[] = [""];
	for (const s of sections) {
		parts.push(`### ${s.title}`);
		parts.push("");
		parts.push(...s.lines);
		parts.push("");
	}
	return parts.join("\n");
}

interface MergeResult {
	merged: boolean;
	changelogPath: string;
	nextPath: string;
}

async function mergeOne(nextPath: string): Promise<MergeResult> {
	const nextContent = await Bun.file(nextPath).text();
	const incoming = parseNextSections(nextContent);

	if (incoming.length === 0) {
		return { merged: false, changelogPath: "", nextPath };
	}

	const changelogPath = nextPath.replace(/\.next$/, ".md");
	const changelogContent = await Bun.file(changelogPath).text();
	const changelogLines = changelogContent.split("\n");

	const range = findUnreleasedRange(changelogLines);
	if (!range) {
		throw new Error(`${changelogPath}: no [Unreleased] section found`);
	}
	const [start, end] = range;

	const existing = parseExistingSubsections(changelogLines, start, end);
	const merged = mergeSubsections(existing, incoming);
	const newBody = renderUnreleasedBody(merged);

	// Rebuild: lines before [Unreleased heading+1] + new body + lines from [end]
	const before = changelogLines.slice(0, start + 1); // includes "## [Unreleased]" line
	const after = changelogLines.slice(end);

	const rebuilt = [...before, newBody, ...after].join("\n");
	const normalized = rebuilt.replace(/\n{3,}/g, "\n\n");
	await Bun.write(changelogPath, normalized);

	return { merged: true, changelogPath, nextPath };
}

const NEXT_STUB = `# Fork-local changelog (next release)
#
# Entries here are specific to this fork and intentionally kept OUT of CHANGELOG.md
# to avoid rebase conflicts against upstream. At release time, \`scripts/merge-changelog-next.ts\`
# concatenates these sections into CHANGELOG.md under ## [Unreleased], then clears this file.
#
# Keep the same section format as CHANGELOG.md (### Added / ### Changed / ### Fixed / ### Removed).
`;

export async function mergeChangelogNext(): Promise<{ merged: string[]; skipped: string[] }> {
	const glob = new Glob(NEXT_GLOB);
	const merged: string[] = [];
	const skipped: string[] = [];

	for await (const nextPath of glob.scan(PACKAGE_ROOT)) {
		const result = await mergeOne(nextPath);
		if (result.merged) {
			await Bun.write(nextPath, NEXT_STUB);
			merged.push(result.changelogPath);
		} else {
			skipped.push(nextPath);
		}
	}

	return { merged, skipped };
}

if (import.meta.main) {
	const { merged, skipped } = await mergeChangelogNext();
	if (merged.length > 0) {
		console.log("Merged CHANGELOG.next into:");
		for (const p of merged) console.log(`  ${p}`);
	}
	if (skipped.length > 0) {
		console.log("Skipped (no content):");
		for (const p of skipped) console.log(`  ${p}`);
	}
	if (merged.length === 0 && skipped.length === 0) {
		console.log("No CHANGELOG.next files found.");
	}
}
