import { any, cond, filter, reduce, T } from 'ramda'
import { spawnAndComplete } from './spawn'
import { getFilesWithConflictMarkers } from './diff-check'
import {
  WorkingDirectoryStatus,
  WorkingDirectoryFileChange,
  AppFileStatus,
  FileEntry,
  GitStatusEntry,
  OrdinaryEntry,
  isOrdinaryEntry,
  RenamedOrCopiedEntry,
  isRenamedOrCopiedEntry,
  UntrackedEntry,
  isUntrackedEntry,
  UnmergedEntry,
  isUnmergedEntry,
} from '../../models/status'
import {
  parsePorcelainStatus,
  mapStatus,
  IStatusEntry,
  IStatusHeader,
  isStatusHeader,
  isStatusEntry,
} from '../status-parser'
import { DiffSelectionType, DiffSelection } from '../../models/diff'
import { Repository } from '../../models/repository'
import { IAheadBehind } from '../../models/branch'
import { fatalError } from '../../lib/fatal-error'
import { enableStatusWithoutOptionalLocks } from '../feature-flag'

/**
 * V8 has a limit on the size of string it can create (~256MB), and unless we want to
 * trigger an unhandled exception we need to do the encoding conversion by hand.
 *
 * As we may be executing status often, we should keep this to a reasonable threshold.
 */
const MaxStatusBufferSize = 20e6 // 20MB in decimal

/** The encapsulation of the result from 'git status' */
export interface IStatusResult {
  readonly currentBranch?: string
  readonly currentUpstreamBranch?: string
  readonly currentTip?: string
  readonly branchAheadBehind?: IAheadBehind

  /** true if the repository exists at the given location */
  readonly exists: boolean

  /** the absolute path to the repository's working directory */
  readonly workingDirectory: WorkingDirectoryStatus
}

type StatusHeadersData = {
  currentBranch: string | undefined
  currentUpstreamBranch: string | undefined
  currentTip: string | undefined
  branchAheadBehind: IAheadBehind | undefined
  match: RegExpMatchArray | null
}

function convertToAppStatus(
  status: FileEntry,
  hasConflictMarkers: boolean
): AppFileStatus {
  return <AppFileStatus>(
    cond([
      [isOrdinaryEntry, ordinaryStatusCond],
      [isRenamedOrCopiedEntry, renamedOrCopiedCond],
      [
        isUnmergedEntry,
        () =>
          hasConflictMarkers
            ? AppFileStatus.Conflicted
            : AppFileStatus.Resolved,
      ],
      [isUntrackedEntry, () => AppFileStatus.New],
      [T, () => fatalError(`Unknown file status ${status}`)],
    ])(status)
  )
}

const ordinaryStatusCond = cond<OrdinaryEntry, AppFileStatus>([
  [status => status.type === 'added', () => AppFileStatus.New],
  [status => status.type === 'modified', () => AppFileStatus.Modified],
  [status => status.type === 'deleted', () => AppFileStatus.Deleted],
])

const renamedOrCopiedCond = cond<RenamedOrCopiedEntry, AppFileStatus>([
  [status => status.kind === 'renamed', () => AppFileStatus.Renamed],
  [status => status.kind === 'copied', () => AppFileStatus.Copied],
])

/**
 *  Retrieve the status for a given repository,
 *  and fail gracefully if the location is not a Git repository
 */
export async function getStatus(
  repository: Repository
): Promise<IStatusResult | null> {
  const baseArgs = [
    'status',
    '--untracked-files=all',
    '--branch',
    '--porcelain=2',
    '-z',
  ]

  const args = enableStatusWithoutOptionalLocks()
    ? ['--no-optional-locks', ...baseArgs]
    : baseArgs

  const result = await spawnAndComplete(
    args,
    repository.path,
    'getStatus',
    new Set([0, 128])
  )

  if (result.exitCode === 128) {
    log.debug(
      `'git status' returned 128 for '${
        repository.path
      }' and is likely missing its .git directory`
    )
    return null
  }

  if (result.output.length > MaxStatusBufferSize) {
    log.error(
      `'git status' emitted ${
        result.output.length
      } bytes, which is beyond the supported threshold of ${MaxStatusBufferSize} bytes`
    )
    return null
  }

  const stdout = result.output.toString('utf8')
  const parsed = parsePorcelainStatus(stdout)
  const headers = <ReadonlyArray<IStatusHeader>>filter(isStatusHeader, parsed)
  const entries = <ReadonlyArray<IStatusEntry>>filter(isStatusEntry, parsed)

  // run git diff check if anything is conflicted
  const filesWithConflictMarkers = any(
    es => mapStatus(es.statusCode).kind === 'conflicted',
    entries
  )
    ? await getFilesWithConflictMarkers(repository.path)
    : new Set<string>()

  // Map of files keyed on their paths.
  const files = reduce(
    (files, entry) => buildStatusMap(files, entry, filesWithConflictMarkers),
    new Map<string, WorkingDirectoryFileChange>(),
    entries
  )

  const {
    currentBranch,
    currentUpstreamBranch,
    currentTip,
    branchAheadBehind,
  }: StatusHeadersData = reduce(
    parseStatusHeader,
    {
      currentBranch: undefined,
      currentUpstreamBranch: undefined,
      currentTip: undefined,
      branchAheadBehind: undefined,
      match: null,
    },
    headers
  )

  const workingDirectory = WorkingDirectoryStatus.fromFiles([...files.values()])

  return {
    currentBranch,
    currentTip,
    currentUpstreamBranch,
    branchAheadBehind,
    exists: true,
    workingDirectory,
  }
}

/**
 *
 * Update map of working directory changes with a file status entry.
 * Reducer(ish).
 *
 * (Map is used here to maintain insertion order.)
 */
function buildStatusMap(
  files: Map<string, WorkingDirectoryFileChange>,
  entry: IStatusEntry,
  filesWithConflictMarkers: Set<string>
): Map<string, WorkingDirectoryFileChange> {
  const status = mapStatus(entry.statusCode)

  if (status.kind === 'ordinary') {
    // when a file is added in the index but then removed in the working
    // directory, the file won't be part of the commit, so we can skip
    // displaying this entry in the changes list
    if (
      status.index === GitStatusEntry.Added &&
      status.workingTree === GitStatusEntry.Deleted
    ) {
      return files
    }
  }

  if (status.kind === 'untracked') {
    // when a delete has been staged, but an untracked file exists with the
    // same path, we should ensure that we only draw one entry in the
    // changes list - see if an entry already exists for this path and
    // remove it if found
    files.delete(entry.path)
  }

  // for now we just poke at the existing summary
  const summary = convertToAppStatus(
    status,
    filesWithConflictMarkers.has(entry.path)
  )
  const selection = DiffSelection.fromInitialSelection(DiffSelectionType.All)

  files.set(
    entry.path,
    new WorkingDirectoryFileChange(
      entry.path,
      summary,
      selection,
      entry.oldPath
    )
  )
  return files
}

/**
 * Update status header based on the current header entry.
 * Reducer.
 */
function parseStatusHeader(results: StatusHeadersData, header: IStatusHeader) {
  let {
    currentBranch,
    currentUpstreamBranch,
    currentTip,
    branchAheadBehind,
    match,
  } = results
  const value = header.value

  // This intentionally does not match branch.oid initial
  if ((match = value.match(/^branch\.oid ([a-f0-9]+)$/))) {
    currentTip = match[1]
  } else if ((match = value.match(/^branch.head (.*)/))) {
    if (match[1] !== '(detached)') {
      currentBranch = match[1]
    }
  } else if ((match = value.match(/^branch.upstream (.*)/))) {
    currentUpstreamBranch = match[1]
  } else if ((match = value.match(/^branch.ab \+(\d+) -(\d+)$/))) {
    const ahead = parseInt(match[1], 10)
    const behind = parseInt(match[2], 10)

    if (!isNaN(ahead) && !isNaN(behind)) {
      branchAheadBehind = { ahead, behind }
    }
  }
  return {
    currentBranch,
    currentUpstreamBranch,
    currentTip,
    branchAheadBehind,
    match,
  }
}
