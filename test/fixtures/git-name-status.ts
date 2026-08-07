const nul = "\0";

export const completeNameStatusOutput = [
  "A",
  "src/中文 file.ts",
  "D",
  "deleted file.ts",
  "M",
  "src/literal\tname.ts",
  "R100",
  "renames/old\tname.ts",
  "renames/new 中文 name.ts",
  "C75",
  "copies/source file.ts",
  "copies/destination\tfile.ts",
  "T",
  "links/changed target",
  "U",
  "conflicts/unmerged file.ts",
].join(nul) + nul;

export const malformedNameStatusOutputs = [
  "M\0",
  "R100\0renames/old-only.ts\0",
  "C75\0copies/source.ts\0\0",
  "X\0unknown-status.ts\0",
  "A\0missing-terminal.ts",
];

export const interleavedMalformedNameStatusOutput = [
  "",
  "X",
  "not-a-status",
  "M",
  "",
  "R100",
  "renames/lost-source.ts",
  "",
  "C75",
  "copies/lost-source.ts",
  "",
  "A",
  "added.ts",
  "R100",
  "renames/old.ts",
  "renames/new.ts",
  "M",
  "modified.ts",
].join(nul) + nul;
