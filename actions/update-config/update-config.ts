import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as github from '@actions/github';
import { GitHub } from '@actions/github/lib/utils';

const CONFIG_PATH = path.join('.github', 'workflows', 'sync-openapi.yml');

type OpenAPISpec = {
  source: string;
  destination: string;
};

type FileData = {
  type: 'file';
  sha: string;
  content?: string;
  [key: string]: any;
};

type FileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
type DiffFile = Record<string, ['D', string] | ['R', string, string]>;                    

async function run(): Promise<void> {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      core.setFailed(`Config file not found at ${CONFIG_PATH}`);
      return;
    }

    const configRaw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = yaml.load(configRaw) as Record<string, any>;

    const syncStep = config.jobs.sync.steps?.find((step: any) => step.with?.openapi);
    if (!syncStep.with) {
      syncStep.with = {};
    }

    const openapiMapping = syncStep?.with?.openapi; 
    if (!openapiMapping) {
      core.setFailed('Missing openapi block in sync job');
      return;
    }

    const token = core.getInput('token') || process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GitHub token is required');
    }
    const octokit: InstanceType<typeof GitHub> = github.getOctokit(token);
    
    // Get base and head commits using github.event context for push events
    const baseSha = github.context.payload.before;
    const headSha = github.context.payload.after;
    
    if (!baseSha || !headSha) {
      core.setFailed('Could not determine base or head commit SHA');
      return;
    }
    
    core.info(`Base commit: ${baseSha}`);
    core.info(`Head commit: ${headSha}`);

    const specs = parseOpenAPIBlock(openapiMapping);

    if (specs.length === 0) {
      core.info('No tracked files, skipping update.');
      return;
    }

    let changes = await getDiffFiles(baseSha, headSha, octokit);
    
    if (Object.keys(changes).length === 0) {
      core.info('No tracked files were renamed/deleted, skipping update.');
      return;
    }

    const updatedSpecs = updateSpecsToMap(specs, changes);
    const updatedYaml = replaceSpecsInYaml(updatedSpecs, configRaw);

    fs.writeFileSync(CONFIG_PATH, updatedYaml);
    await autoCommitAndPushChanges(octokit);

    core.info('Successfully updated openapi-sync.yml');
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

function parseOpenAPIBlock(block: string): OpenAPISpec[] {
  const parsed = yaml.load(block);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed as OpenAPISpec[];
}

async function getDiffFiles(
  baseSha: string,
  headSha: string,
  octokit: InstanceType<typeof GitHub>
): Promise<DiffFile> {
  const { data: compareData } = await octokit.rest.repos.compareCommits({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    base: baseSha,
    head: headSha,
  });

  const diff: Record<string, ['D', string] | ['R', string, string]> = {};

  for (const file of compareData.files || []) {
    const status = file.status as FileStatus;

    if (status === 'removed') {
      diff[file.filename] = ['D', file.filename];
    } else if (status === 'renamed') {
      diff[file.previous_filename!] = ['R', file.previous_filename!, file.filename];
    }
  }

  return diff;
}

function updateSpecsToMap(
  specs: OpenAPISpec[],
  changes: Record<string, ['D', string] | ['R', string, string]>
): Map<OpenAPISpec, OpenAPISpec | null> {
  const updated = new Map<OpenAPISpec, OpenAPISpec | null>();

  for (const spec of specs) {
    const change = changes[spec.source];

    if (!change) {
      updated.set(spec, spec); // unchanged
      continue;
    }

    if (change[0] === 'D') {
      core.info(`[REMOVE] ${spec.source} in config.`);
      updated.set(spec, null);
      continue;
    }

    if (change[0] === 'R') {
      const [, oldPath, newPath] = change;
      if (!newPath) {
        core.warning(`Missing new path for renamed file: ${oldPath}`);
        updated.set(spec, null);
        continue;
      }

      core.info(`[RENAME] ${oldPath} -> ${newPath} in config.`);
      updated.set(spec, {
        source: newPath,
        destination: spec.destination
      });
    }
  }

  return updated;
}  

function replaceSpecsInYaml(
  updatedSpecs: Map<OpenAPISpec, OpenAPISpec | null>,
  yamlContent: string
): string {
  let updatedYaml = yamlContent;
  
  for (const [oldSpec, newSpec] of updatedSpecs.entries()) {
    if (oldSpec === newSpec) continue;
    
    if (newSpec === null) {
      const pattern = new RegExp(`\\s*- source:\\s*${escapeRegExp(oldSpec.source)}[^-]*?(?=\\s*-|$)`, 'gs');
      updatedYaml = updatedYaml.replace(pattern, '');
    } else {
      const sourcePattern = new RegExp(`(\\s*- source:\\s*)${escapeRegExp(oldSpec.source)}`, 'g');
      updatedYaml = updatedYaml.replace(sourcePattern, `$1${newSpec.source}`);
      
      const destPattern = new RegExp(`(\\s*destination:\\s*)${escapeRegExp(oldSpec.destination)}`, 'g');
      updatedYaml = updatedYaml.replace(destPattern, `$1${newSpec.destination}`);
    }
  }
  
  return updatedYaml;
}
  
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function autoCommitAndPushChanges(octokit: InstanceType<typeof GitHub>): Promise<void> {
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    
    // For push events on main, we're already on the main branch
    const branch = 'main';

    const response = await octokit.rest.repos.getContent({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      path: CONFIG_PATH,
      ref: github.context.sha,
    });
    
    const fileData = response.data as FileData;
    
    if (fileData.type !== 'file') {
      throw new Error('Path exists but is not a file');
    }
    
    const fileSha = fileData.sha;

    await octokit.rest.repos.createOrUpdateFileContents({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      path: CONFIG_PATH,
      message: 'chore: update renamed/deleted files referenced in openapi-sync.yml [skip ci]',
      content: Buffer.from(content).toString('base64'),
      sha: fileSha,
      branch,
      committer: {
        name: 'github-actions',
        email: 'github-actions@github.com',
      },
      author: {
        name: 'github-actions',
        email: 'github-actions@github.com',
      },
    });
    
    core.info('Changes committed and pushed to main branch.');
  } catch (error: any) {
    throw error;
  }
}

run();