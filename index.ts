import { Command } from 'commander';
import z from 'zod';
import { createOSServiceManager } from './os-service-manager';
import readme from './README.md';
import { uniquesBy } from './uniques';
import yaml from './yaml';

const program = new Command();

const home = process.env.HOME;

const cliName = 'cl-tunnel';

program
  .name(cliName)
  .description(
    'Quick CLI tool for managing Cloudflare tunnels with ingress configuration'
  )
  .version('0.3.1');

const cloudflaredConfigFile = `${home}/.cloudflared/config.yml`;

const serviceManager = createOSServiceManager();

program
  .command('install-service')
  .description('Install cloudflared service')
  .action(async () => {
    console.log('Installing cloudflared service...');

    try {
      // Install the service using cloudflared CLI
      await Bun.$`cloudflared service install`;
      console.log('Service installed successfully');

      // Check if service file exists
      const serviceFilePath = serviceManager.getServiceFilePath();
      if (!(await Bun.file(serviceFilePath).exists())) {
        console.error(`Service file not found at: ${serviceFilePath}`);
        return;
      }

      // Get cloudflared binary path
      const result = await Bun.$`which cloudflared`.text();
      const cloudflaredBinPath = result.trim();
      console.log(`Found cloudflared binary at: ${cloudflaredBinPath}`);

      console.log('Will try to patch service file at: ', serviceFilePath);

      // Check if already patched
      if (await serviceManager.isServiceFilePatched(cloudflaredBinPath)) {
        console.log('Service file already patched');
      } else {
        // Apply patch
        await serviceManager.patchServiceFile(cloudflaredBinPath);
        console.log('Service file patched successfully');

        // Restart the service
        console.log('Reloading cloudflared service definition...');
        await serviceManager.reloadServiceDefinition();
      }

      console.log('Service restarted successfully');
    } catch (error) {
      console.error('Failed to install service:', error);
    }
  });

program
  .command('remove-service')
  .description('Remove cloudflared service installation')
  .action(async () => {
    console.log('Removing cloudflared service...');

    try {
      // Stop the service first
      console.log('Stopping cloudflared service...');
      // await serviceManager.stopService();

      // Remove the service installation using cloudflared CLI
      await Bun.$`cloudflared service uninstall`;
      console.log('Service removed successfully');
    } catch (error) {
      console.error('Failed to remove service:', error);
    }
  });

// this is the the cli's config file schema
const cliConfigFileSchema = z.object({
  domain: z.hostname(),
});

const cliConfigFilePath = `${home}/.cl-tunnel/config.json`;

program
  .command('init')
  .description('Initialize CLI configuration')
  .argument('<domain>', 'The domain to use for tunnels (e.g., google.com)')
  .action(async (domain) => {
    console.log(`Initializing CLI configuration with domain: ${domain}`);

    const config = {
      domain: domain,
    };

    try {
      // Validate the domain using the schema
      await cliConfigFileSchema.parseAsync(config);

      // Write the config file
      await Bun.write(cliConfigFilePath, JSON.stringify(config, null, 2));

      console.log(`Configuration written to: ${cliConfigFilePath}`);
      console.log('Config contents:');
      console.log(JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Failed to initialize configuration:', error);
      process.exit(1);
    }
  });

class CliConfigFileNotFoundError extends Error {
  constructor() {
    super('CLI config file does not exist');
  }
}

async function getCliConfig() {
  if (!(await Bun.file(cliConfigFilePath).exists())) {
    throw new CliConfigFileNotFoundError();
  }

  const string = await Bun.file(cliConfigFilePath).text();
  const parsed = JSON.parse(string);
  const validated = await cliConfigFileSchema.parseAsync(parsed);
  return validated;
}

const logs = serviceManager.getLogPaths();

const configSchema = z.object({
  tunnel: z.uuid(),
  'credentials-file': z.string().refine(async (path) => {
    try {
      await Bun.file(path).exists();
      return true;
    } catch {
      return false;
    }
  }, 'Credentials file must be a valid path to a file that exists'),
  ingress: z.array(
    z.object({
      hostname: z.string().optional(),
      service: z
        .url()
        .or(
          z
            .string()
            .refine(
              (str) => str.startsWith('http_status:'),
              'Service must be a valid URL or a valid HTTP status code response like "http_status:404"'
            )
        ),
    })
  ),
});

async function getValidCloudflaredConfig() {
  const string = await Bun.file(cloudflaredConfigFile).text();
  const parsed = yaml.parse(string);
  const validated = await configSchema.parseAsync(parsed);
  return { string: string, config: validated };
}

program
  .command('config')
  .description('Show the CLI config file')
  .action(async () => {
    const config = await getCliConfig();
    console.log(cliConfigFilePath);
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command('list')
  .description('List items')
  .action(async () => {
    try {
      const { config } = await getValidCloudflaredConfig();

      const tableEntries = config.ingress
        .filter((rule) => rule.hostname)
        .map((rule) => {
          const subdomain = rule.hostname?.replace('.' + domain, '');
          return {
            name: subdomain,
            url: `https://${rule.hostname}`,
            'local service': rule.service,
          };
        });

      console.table(tableEntries);
    } catch (error) {
      console.error('Error reading cloudflared config:', error);
      process.exit(1);
    }
  });

program
  .command('add')
  .description('Add a new subdomain mapping to a local port')
  .argument(
    '<subdomain>',
    `The subdomain to map (e.g., "api" for api.domain.com)`
  )
  .argument('<port>', 'The local port number to map to')
  .option('-f, --force', 'Force override existing ingress rule')
  .action(
    async (subdomain: string, port: string, options: { force: boolean }) => {
      // Validate subdomain format
      // cloudflare only supports automatic SSL termination for subdomains 1 level deep
      validateNewEntry({ subdomain, port });

      console.log(`Adding mapping: ${subdomain} -> localhost:${port}`);

      const { config, string: originalConfig } =
        await getValidCloudflaredConfig();

      const hasIngress = config.ingress.some(
        (rule) => rule.hostname === `${subdomain}.${domain}`
      );

      if (hasIngress && !options.force) {
        console.error(
          `Ingress rule for ${subdomain} already exists. If you want to override it, add -f or --force`
        );
        return;
      }

      const newIngress = {
        hostname: `${subdomain}.${domain}`,
        service: `http://localhost:${port}`,
      };

      config.ingress.push(newIngress);

      config.ingress.sort((a, b) => {
        // Rules without hostname should come last
        if (!a.hostname && !b.hostname) return 0;
        if (!a.hostname) return 1;
        if (!b.hostname) return -1;

        // Both have hostnames, sort alphabetically
        return a.hostname.localeCompare(b.hostname);
      });

      config.ingress = uniquesBy(config.ingress, (rule) => rule.hostname);

      const updatedConfig = yaml.stringify(config);

      await Bun.write(cloudflaredConfigFile, updatedConfig);

      let isValid = false;
      try {
        // calling it like this will log out any errors to the console
        await Bun.$`cloudflared tunnel ingress validate`;
        isValid = true;
      } catch (error) {
        isValid = false;
      }

      if (!isValid) {
        console.error('Ingress rule is not valid, rolling back config...');
        await Bun.write(cloudflaredConfigFile, originalConfig);
        console.log('Cloudflared config rolled back');
        return;
      }

      console.log(`Ingress rule for ${subdomain} added successfully`);

      try {
        await Bun.$`cloudflared tunnel route dns ${config.tunnel} ${subdomain}`;
      } catch (error) {
        console.error('Error adding ingress rule:', error);

        console.log('Rolling back config...');
        await Bun.write(cloudflaredConfigFile, originalConfig);
        console.log('Cloudflared config rolled back');

        return;
      }

      try {
        console.log('Restarting cloudflared...');
        await serviceManager.restartService();
        console.log('Cloudflared restarted successfully');
      } catch (error) {
        console.error('Error restarting cloudflared:', error);

        console.log('Rolling back config...');
        await Bun.write(cloudflaredConfigFile, originalConfig);

        console.log('Restarting cloudflared after rollback...');
        await serviceManager.restartService();
        console.log('Cloudflared restarted successfully');
        return;
      }
    }
  );

function validateNewEntry({
  subdomain,
  port,
}: {
  subdomain: string;
  port: string;
}) {
  const validationSchema = z.object({
    subdomain: z
      .string()
      .regex(
        /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i,
        'Subdomains must contain only alphanumeric characters and hyphens, cannot start or end with a hyphen, and must be 1-63 characters long. Cloudflare only supports automatic SSL termination for subdomains 1 level deep.'
      ),
    port: z.string().refine((val) => {
      const num = parseInt(val);
      return !isNaN(num) && num >= 1 && num <= 65535;
    }, 'Port must be a number between 1 and 65535.'),
  });

  try {
    validationSchema.parse({ subdomain, port });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation errors:');
      error.issues.forEach((err) => {
        console.error(
          `  Invalid ${err.path.join('.')}: "${
            err.path[0] === 'subdomain' ? subdomain : port
          }". ${err.message}`
        );
      });
    } else {
      console.error('Validation error:', error);
    }
    process.exit(1);
  }
}

program
  .command('remove')
  .description('Remove a subdomain mapping from cloudflared tunnel')
  .argument(
    '<subdomain>',
    `The subdomain to remove (e.g., "api" for api.domain.com)`
  )
  .action(async (subdomain: string) => {
    console.log(`Removing mapping for: ${subdomain}.${domain}`);

    const { config } = await getValidCloudflaredConfig();

    const hostname = `${subdomain}.${domain}`;
    const initialLength = config.ingress.length;

    // Remove the ingress rule
    config.ingress = config.ingress.filter(
      (rule) => rule.hostname !== hostname
    );

    if (config.ingress.length === initialLength) {
      console.error(`No ingress rule found for ${subdomain}.${domain}`);
      return;
    }

    const updatedConfig = yaml.stringify(config);
    await Bun.write(cloudflaredConfigFile, updatedConfig);

    console.log(`Ingress rule for ${subdomain} removed successfully`);

    // Remove the DNS record
    // TODO: implement this - cloudflared does not support removing DNS records

    // Restart cloudflared
    console.log('Restarting cloudflared...');
    await serviceManager.restartService();
    console.log('Cloudflared restarted successfully');
  });

program
  .command('logs')
  .description(
    'Tail cloudflared tunnel logs (err logs, which is where cloudflared logs everything by default)'
  )
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action(async (options) => {
    const lines = parseInt(options.lines);
    const logFile = logs.err; // using err logs because that's where cloudflared logs everything

    console.log(`Reading logs from: ${logFile}`);

    try {
      await Bun.$`tail -n ${lines} ${logFile}`;
    } catch (error) {
      console.error(`Failed to read logs from ${logFile}:`, error);
    }
  });

program
  .command('logs-out')
  .description('Tail cloudflared tunnel output logs')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action(async (options) => {
    const lines = parseInt(options.lines);
    const errorLogFile = logs.out;

    console.log(`Reading error logs from: ${errorLogFile}`);

    try {
      await Bun.$`tail -n ${lines} ${errorLogFile}`;
    } catch (error) {
      console.error(`Failed to read error logs from ${errorLogFile}:`, error);
    }
  });

program
  .command('restart')
  .description('Restart cloudflared tunnel')
  .action(async () => {
    console.log('Restarting cloudflared tunnel...');

    try {
      await serviceManager.restartService();
      console.log('Cloudflared tunnel restarted successfully');
    } catch (error) {
      console.error('Failed to restart cloudflared tunnel:', error);
    }
  });

program
  .command('stop')
  .description('Stop cloudflared tunnel')
  .action(async () => {
    console.log('Stopping cloudflared tunnel...');

    try {
      await serviceManager.stopService();
      console.log('Cloudflared tunnel stopped successfully');
    } catch (error) {
      console.error('Failed to stop cloudflared tunnel:', error);
    }
  });

async function validateCloudflaredSetup() {
  const { exitCode } = await Bun.$`which cloudflared`.nothrow().quiet();
  if (exitCode !== 0) {
    console.error(
      'cloudflared is not installed. Please install it before using this tool'
    );
    const instructions = serviceManager.getInstallInstructions();
    instructions.forEach((instruction) => console.log(instruction));
    console.log(
      'Or visit the Cloudflare docs for installation instructions: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/'
    );
    process.exit(1);
  }

  try {
    await getValidCloudflaredConfig();
  } catch (e) {
    console.error('Failed to get cloudflared config:', e);
    console.log(
      'Make sure to properly setup cloudflared tunnel before using this tool:'
    );
    console.log(
      '1. Run `cloudflared tunnel login` to login to your cloudflare account'
    );
    console.log(
      '2. Run `cloudflared tunnel create <tunnel-name>` to create a new tunnel. You can name it whatever you want, like: local-dev-mac-tunnel'
    );
    console.log('');
    console.log(
      'This will authenticate cloudflared with you account, create a new tunnel, and write a config file to ~/.cloudflared/config.yml'
    );
    console.log('');
    console.log('Then you can start using this tool');
    process.exit(1);
  }

  try {
    return await getCliConfig();
  } catch (e) {
    if (e instanceof CliConfigFileNotFoundError) {
      console.error('CLI config file does not exist');
    } else {
      console.error('Failed to get CLI config:', e);
      console.log('CLI configuration file not found or invalid.');
    }

    console.log(`Please run: ${cliName} init <domain>`);

    process.exit(1);
  }
}

let cliConfig: z.infer<typeof cliConfigFileSchema>;
let domain: string;

program.hook('preAction', async (_, actionCommand) => {
  const commandBeingRun = actionCommand.name();
  const skipCommands = ['init', 'install-service', 'remove-service'];
  if (!skipCommands.includes(commandBeingRun)) {
    cliConfig = await validateCloudflaredSetup();
    domain = cliConfig.domain;
  }
});

program
  .command('readme')
  .description('Print the README documentation')
  .action(async () => {
    const { marked } = await import('marked');
    const { markedTerminal } = await import('marked-terminal');
    marked.use(markedTerminal({}) as any);

    const readmeContent = await Bun.file(readme).text();

    const renderedMarkdown = marked(readmeContent);
    console.log(renderedMarkdown);
  });

program.parse();
