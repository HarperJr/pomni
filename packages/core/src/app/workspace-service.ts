import { DEFAULT_CONFIG, PomniConfigSchema, type PomniConfig } from '../domain/config.js';
import { layout } from '../domain/layout.js';
import type { Repo, ResolvedRepo } from '../domain/repo.js';
import type { DocStore, FsProbe } from '../ports/index.js';

/**
 * Owns the `.pomni` workspace itself: initialisation, config, and the one piece of
 * knowledge everything else depends on — where a repo's code actually sits right now.
 */
export class WorkspaceService {
  constructor(
    private readonly docs: DocStore,
    private readonly fs: FsProbe,
  ) {}

  get root(): string {
    return this.docs.root;
  }

  async isInitialized(): Promise<boolean> {
    return this.docs.exists(layout.config);
  }

  async init(): Promise<PomniConfig> {
    const existing = await this.docs.read(layout.config, PomniConfigSchema);
    if (existing) return existing.data;

    await this.docs.ensureDir(layout.projectsDir);
    await this.docs.ensureDir(layout.workspaceDir);
    await this.docs.write(layout.config, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  async config(): Promise<PomniConfig> {
    const ref = await this.docs.read(layout.config, PomniConfigSchema);
    return ref?.data ?? DEFAULT_CONFIG;
  }

  async setConfig(patch: Partial<PomniConfig>): Promise<PomniConfig> {
    const current = await this.config();
    const next = PomniConfigSchema.parse({ ...current, ...patch });
    await this.docs.write(layout.config, next);
    return next;
  }

  /**
   * Where this repo's code lives on this machine.
   *
   * A `local` repo resolves to the path the user linked; a `git` repo resolves to its
   * slot in the managed workspace. Consumers never branch on source kind — this is the
   * only place that does, which is what keeps future source kinds cheap.
   */
  workingDir(repo: Pick<Repo, 'id' | 'projectId' | 'source'>): string {
    if (repo.source.kind === 'local') return this.fs.resolve(repo.source.path);
    return this.docs.absolute(layout.workspaceRepo(repo.projectId, repo.id));
  }

  async resolve(repo: Repo): Promise<ResolvedRepo> {
    const workingDir = this.workingDir(repo);
    const workingDirExists = await this.fs.isDirectory(workingDir);
    return { ...repo, workingDir, workingDirExists };
  }

  async resolveAll(repos: Repo[]): Promise<ResolvedRepo[]> {
    return Promise.all(repos.map((repo) => this.resolve(repo)));
  }
}
