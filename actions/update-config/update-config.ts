import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { GitHub } from '@actions/github/lib/utils';
const CONFIG_PATH = path.join('.github', 'workflows', 'sync-openapi.yml');

type OpenAPISpec = {
  source: string;
  destination: string;
};

type FileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
type DiffFile = Record<string, ['D', string] | ['R', string, string]>;                    

type CompareCommitsResponse = RestEndpointMethodTypes['repos']['compareCommits']['response'];
type FileEntry = NonNullable<CompareCommitsResponse['data']['files']>[number];

async function getBaseRef(octokit: InstanceType<typeof GitHub>): Promise<string> {
    const baseRef = process.env.GITHUB_BASE_REF;
    if (!baseRef) {
        throw new Error('GITHUB_BASE_REF not found. Are you running in a PR context?');
    }

    const { data: baseRefData } = await octokit.rest.repos.getBranch({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        branch: baseRef,
    });
    return baseRefData.commit.sha;
}

async function getDiffFiles(
    baseRef: string,
    octokit: InstanceType<typeof GitHub>
  ): Promise<DiffFile> {
    const headSha = github.context.sha;
  
    const { data: compareData } = await octokit.rest.repos.compareCommits({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      base: baseRef,
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
  
function parseOpenAPIBlock(block: string): OpenAPISpec[] {
  const parsed = yaml.load(block);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed as OpenAPISpec[];
}

function formatOpenAPIBlock(specs: OpenAPISpec[]): string {
  return specs.map(spec => `  - source: ${spec.source}\n    destination: ${spec.destination}`).join('\n');
}

function updateSpecs(
    specs: OpenAPISpec[],
    changes: Record<string, ['D', string] | ['R', string, string]>
  ): OpenAPISpec[] {
    const updated: OpenAPISpec[] = [];
  
    for (const spec of specs) {
      const change = changes[spec.source];
  
      if (!change) {
        updated.push(spec);
        continue;
      }
  
      if (change[0] === 'D') {
        core.info(`[REMOVE] ${spec.source} in config.`);
        continue; // skip deleted spec
      }
  
      if (change[0] === 'R') {
        const [, oldPath, newPath] = change;
        if (!newPath) {
          core.warning(`Missing new path for renamed file: ${oldPath}`);
          continue;
        }
  
        core.info(`[RENAME]${oldPath} -> ${newPath} in config.`);
        updated.push({
          source: newPath,
          destination: spec.destination.replace(
            path.basename(spec.source),
            path.basename(newPath)
          ),
        });
      }
    }
  
    return updated;
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
    
    // Process each spec update
    for (const [oldSpec, newSpec] of updatedSpecs.entries()) {
      // Skip if there's no change
      if (oldSpec === newSpec) continue;
      
      if (newSpec === null) {
        // Handle deletion: remove the entire entry for this spec
        const pattern = new RegExp(`\\s*- source:\\s*${escapeRegExp(oldSpec.source)}[^-]*?(?=\\s*-|$)`, 'gs');
        updatedYaml = updatedYaml.replace(pattern, '');
      } else {
        // Handle rename: replace source and destination
        const sourcePattern = new RegExp(`(\\s*- source:\\s*)${escapeRegExp(oldSpec.source)}`, 'g');
        updatedYaml = updatedYaml.replace(sourcePattern, `$1${newSpec.source}`);
        
        const destPattern = new RegExp(`(\\s*destination:\\s*)${escapeRegExp(oldSpec.destination)}`, 'g');
        updatedYaml = updatedYaml.replace(destPattern, `$1${newSpec.destination}`);
      }
    }
    
    return updatedYaml;
  }
  
// Helper function to escape special regex characters
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type GetContentResponse = RestEndpointMethodTypes['repos']['getContent']['response'];
type FileData = {
  type: 'file';
  sha: string;
  content?: string;
  [key: string]: any;
};

async function autoCommitAndPushIfChanged(octokit: InstanceType<typeof GitHub>): Promise<void> {
    const isFork =
        github.context.payload.pull_request?.head.repo.full_name !== github.context.repo.owner + '/' + github.context.repo.repo;

  if (isFork) {
    core.warning('Skipping commit: PR is from a fork and push is not allowed.');
    return;
  }
  
  // Read the file content
  const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const branch = github.context.payload.pull_request?.head.ref || process.env.GITHUB_HEAD_REF;

  try {
    // Get the current file to check if it exists and get its SHA
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
    // Update the file
    if (!branch) {
      throw new Error('Could not find branch for PR.');
    }

    await octokit.rest.repos.createOrUpdateFileContents({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        path: CONFIG_PATH,
        message: 'chore: auto-update renamed/deleted files referenced in openapi-sync.yml [skip ci]',
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
    
    core.info('Changes committed and pushed.');
  } catch (error: any) {
        throw error;
  }
}

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

    const baseRef = await getBaseRef(octokit);

    const specs = parseOpenAPIBlock(openapiMapping);

    if (specs.length === 0) {
        core.info('No tracked files, skipping update.');
        return;
    }

    let changes = await getDiffFiles(baseRef, octokit);
    
    if (Object.keys(changes).length === 0) {
        core.info('No tracked files were renamed/deleted, skipping update.');
        return;
    }

    const updatedSpecs = updateSpecsToMap(specs, changes);

    const updatedYaml = replaceSpecsInYaml(updatedSpecs, configRaw);

    // const updatedSpecs = updateSpecs(specs, changes);
    // syncStep.with.openapi = formatOpenAPIBlock(updatedSpecs);

    // const updatedYaml = yaml.dump(config, { lineWidth: -1 });
    fs.writeFileSync(CONFIG_PATH, updatedYaml);
    await autoCommitAndPushIfChanged(octokit);

    core.info('Successfully updated openapi-sync.yml');
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();