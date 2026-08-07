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
  "renames/new\n中文 name.ts",
  "C75",
  "copies/source\nfile.ts",
  "copies/destination\tfile.ts",
  "T",
  "links/changed target",
  "U",
  "conflicts/unmerged file.ts",
].join(nul) + nul;

export const malformedNameStatusOutputs = {
  emptyStatus: "\0A\0recovered.ts\0",
  emptyPath: "A\0\0",
  unknownStatus: "X\0unknown-status.ts\0",
  incompleteRecord: "R100\0renames/old-only.ts\0",
  unterminatedStream: "A\0missing-terminal.ts",
  misalignedRecord: "M\0A\0recovered.ts\0",
} as const;

export const malformedStatusPrefixes = [
  "",
  "X",
  "R101",
  "C101",
  "not-a-status",
  "\t",
  "\n",
] as const;
