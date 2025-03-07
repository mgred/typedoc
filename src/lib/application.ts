import * as Path from "path";
import * as ts from "typescript";

import { Converter } from "./converter/index";
import { Renderer } from "./output/renderer";
import { Serializer } from "./serialization";
import type { ProjectReflection } from "./models/index";
import {
    Logger,
    ConsoleLogger,
    CallbackLogger,
    loadPlugins,
    writeFile,
    discoverNpmPlugins,
    NeverIfInternal,
} from "./utils/index";

import {
    AbstractComponent,
    ChildableComponent,
    Component,
} from "./utils/component";
import { Options, BindOption } from "./utils";
import type { TypeDocOptions } from "./utils/options/declaration";
import { flatMap, unique } from "./utils/array";
import { basename } from "path";
import { validateExports } from "./validation/exports";
import { ok } from "assert";
import {
    DocumentationEntryPoint,
    EntryPointStrategy,
    getEntryPoints,
} from "./utils/entry-point";
import { nicePath } from "./utils/paths";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageInfo = require("../../package.json") as {
    version: string;
    peerDependencies: { typescript: string };
};

const supportedVersionMajorMinor = packageInfo.peerDependencies.typescript
    .split("||")
    .map((version) => version.replace(/^\s*|\.x\s*$/g, ""));

/**
 * The default TypeDoc main application class.
 *
 * This class holds the two main components of TypeDoc, the {@link Converter} and
 * the {@link Renderer}. When running TypeDoc, first the {@link Converter} is invoked which
 * generates a {@link ProjectReflection} from the passed in source files. The
 * {@link ProjectReflection} is a hierarchical model representation of the TypeScript
 * project. Afterwards the model is passed to the {@link Renderer} which uses an instance
 * of {@link Theme} to generate the final documentation.
 *
 * Both the {@link Converter} and the {@link Renderer} emit a series of events while processing the project.
 * Subscribe to these Events to control the application flow or alter the output.
 */
@Component({ name: "application", internal: true })
export class Application extends ChildableComponent<
    Application,
    AbstractComponent<Application>
> {
    /**
     * The converter used to create the declaration reflections.
     */
    converter: Converter;

    /**
     * The renderer used to generate the documentation output.
     */
    renderer: Renderer;

    /**
     * The serializer used to generate JSON output.
     */
    serializer: Serializer;

    /**
     * The logger that should be used to output messages.
     */
    logger: Logger;

    options: Options;

    /** @internal */
    @BindOption("logger")
    loggerType!: string | Function;

    /**
     * The version number of TypeDoc.
     */
    static VERSION = packageInfo.version;

    /**
     * Create a new TypeDoc application instance.
     *
     * @param options An object containing the options that should be used.
     */
    constructor() {
        super(null!); // We own ourselves

        this.logger = new ConsoleLogger();
        this.options = new Options(this.logger);
        this.options.addDefaultDeclarations();
        this.serializer = new Serializer();
        this.converter = this.addComponent<Converter>("converter", Converter);
        this.renderer = this.addComponent<Renderer>("renderer", Renderer);
    }

    /**
     * Initialize TypeDoc with the given options object.
     *
     * @param options  The desired options to set.
     */
    bootstrap(options: Partial<TypeDocOptions> = {}): void {
        for (const [key, val] of Object.entries(options)) {
            try {
                this.options.setValue(key as keyof TypeDocOptions, val);
            } catch {
                // Ignore errors, plugins haven't been loaded yet and may declare an option.
            }
        }
        this.options.read(new Logger());

        const logger = this.loggerType;
        if (typeof logger === "function") {
            this.logger = new CallbackLogger(<any>logger);
            this.options.setLogger(this.logger);
        } else if (logger === "none") {
            this.logger = new Logger();
            this.options.setLogger(this.logger);
        }
        this.logger.level = this.options.getValue("logLevel");

        const plugins = this.options.isSet("plugin")
            ? this.options.getValue("plugin")
            : discoverNpmPlugins(this);
        loadPlugins(this, plugins);

        this.options.reset();
        for (const [key, val] of Object.entries(options)) {
            try {
                this.options.setValue(key as keyof TypeDocOptions, val);
            } catch (error) {
                ok(error instanceof Error);
                this.logger.error(error.message);
            }
        }
        this.options.read(this.logger);
    }

    /**
     * Return the application / root component instance.
     */
    override get application(): NeverIfInternal<Application> {
        this.logger.deprecated(
            "Application.application is deprecated. Plugins are now passed the application instance when loaded."
        );
        return this as never;
    }

    /**
     * Return the path to the TypeScript compiler.
     */
    public getTypeScriptPath(): string {
        return nicePath(Path.dirname(require.resolve("typescript")));
    }

    public getTypeScriptVersion(): string {
        return ts.version;
    }

    /**
     * Gets the entry points to be documented according to the current `entryPoints` and `entryPointStrategy` options.
     * May return undefined if entry points fail to be expanded.
     */
    public getEntryPoints(): DocumentationEntryPoint[] | undefined {
        return getEntryPoints(this.logger, this.options);
    }

    /**
     * Run the converter for the given set of files and return the generated reflections.
     *
     * @returns An instance of ProjectReflection on success, undefined otherwise.
     */
    public convert(): ProjectReflection | undefined {
        const start = Date.now();
        // We seal here rather than in the Converter class since TypeDoc's tests reuse the Application
        // with a few different settings.
        this.options.freeze();
        this.logger.verbose(
            `Using TypeScript ${this.getTypeScriptVersion()} from ${this.getTypeScriptPath()}`
        );

        if (
            !supportedVersionMajorMinor.some(
                (version) => version == ts.versionMajorMinor
            )
        ) {
            this.logger.warn(
                `You are running with an unsupported TypeScript version! TypeDoc supports ${supportedVersionMajorMinor.join(
                    ", "
                )}`
            );
        }

        const entryPoints = this.getEntryPoints();

        if (!entryPoints) {
            // Fatal error already reported.
            return;
        }

        const programs = unique(entryPoints.map((e) => e.program));
        this.logger.verbose(
            `Converting with ${programs.length} programs ${entryPoints.length} entry points`
        );

        const errors = flatMap([...programs], ts.getPreEmitDiagnostics);
        if (errors.length) {
            this.logger.diagnostics(errors);
            return;
        }

        if (this.options.getValue("emit")) {
            for (const program of programs) {
                program.emit();
            }
        }

        const startConversion = Date.now();
        this.logger.verbose(
            `Finished getting entry points in ${Date.now() - start}ms`
        );

        const project = this.converter.convert(entryPoints);
        this.logger.verbose(
            `Finished conversion in ${Date.now() - startConversion}ms`
        );
        return project;
    }

    public convertAndWatch(
        success: (project: ProjectReflection) => Promise<void>
    ): void {
        this.options.freeze();
        if (
            !this.options.getValue("preserveWatchOutput") &&
            this.logger instanceof ConsoleLogger
        ) {
            ts.sys.clearScreen?.();
        }

        this.logger.verbose(
            `Using TypeScript ${this.getTypeScriptVersion()} from ${this.getTypeScriptPath()}`
        );

        if (
            !supportedVersionMajorMinor.some(
                (version) => version == ts.versionMajorMinor
            )
        ) {
            this.logger.warn(
                `You are running with an unsupported TypeScript version! TypeDoc supports ${supportedVersionMajorMinor.join(
                    ", "
                )}`
            );
        }

        if (Object.keys(this.options.getCompilerOptions()).length === 0) {
            this.logger.warn(
                `No compiler options set. This likely means that TypeDoc did not find your tsconfig.json. Generated documentation will probably be empty.`
            );
        }

        // Doing this is considerably more complicated, we'd need to manage an array of programs, not convert until all programs
        // have reported in the first time... just error out for now. I'm not convinced anyone will actually notice.
        if (this.options.getFileNames().length === 0) {
            this.logger.error(
                "The provided tsconfig file looks like a solution style tsconfig, which is not supported in watch mode."
            );
            return;
        }

        // Support for packages mode is currently unimplemented
        if (
            this.options.getValue("entryPointStrategy") ===
            EntryPointStrategy.Packages
        ) {
            this.logger.error(
                "The packages option of entryPointStrategy is not supported in watch mode."
            );
            return;
        }

        // Matches the behavior of the tsconfig option reader.
        let tsconfigFile = this.options.getValue("tsconfig");
        tsconfigFile =
            ts.findConfigFile(
                tsconfigFile,
                ts.sys.fileExists,
                tsconfigFile.toLowerCase().endsWith(".json")
                    ? basename(tsconfigFile)
                    : undefined
            ) ?? "tsconfig.json";

        // We don't want to do it the first time to preserve initial debug status messages. They'll be lost
        // after the user saves a file, but better than nothing...
        let firstStatusReport = true;

        const host = ts.createWatchCompilerHost(
            tsconfigFile,
            this.options.fixCompilerOptions({}),
            ts.sys,
            ts.createEmitAndSemanticDiagnosticsBuilderProgram,
            (diagnostic) => this.logger.diagnostic(diagnostic),
            (status, newLine, _options, errorCount) => {
                if (
                    !firstStatusReport &&
                    errorCount === void 0 &&
                    !this.options.getValue("preserveWatchOutput") &&
                    this.logger instanceof ConsoleLogger
                ) {
                    ts.sys.clearScreen?.();
                }
                firstStatusReport = false;
                this.logger.info(
                    ts.flattenDiagnosticMessageText(status.messageText, newLine)
                );
            }
        );

        let successFinished = true;
        let currentProgram: ts.Program | undefined;

        const runSuccess = () => {
            if (!currentProgram) {
                return;
            }

            if (successFinished) {
                this.logger.resetErrors();
                const entryPoints = this.getEntryPoints();
                if (!entryPoints) {
                    return;
                }
                const project = this.converter.convert(entryPoints);
                currentProgram = undefined;
                successFinished = false;
                void success(project).then(() => {
                    successFinished = true;
                    runSuccess();
                });
            }
        };

        const origAfterProgramCreate = host.afterProgramCreate;
        host.afterProgramCreate = (program) => {
            if (ts.getPreEmitDiagnostics(program.getProgram()).length === 0) {
                currentProgram = program.getProgram();
                runSuccess();
            }
            origAfterProgramCreate?.(program);
        };

        ts.createWatchProgram(host);
    }

    validate(project: ProjectReflection) {
        const checks = this.options.getValue("validation");

        if (checks.notExported) {
            validateExports(
                project,
                this.logger,
                this.options.getValue("intentionallyNotExported")
            );
        }

        // checks.invalidLink is currently handled when rendering by the MarkedLinksPlugin.
        // It should really move here, but I'm putting that off until done refactoring the comment
        // parsing so that we don't have duplicate parse logic all over the place.
    }

    /**
     * Render HTML for the given project
     */
    public async generateDocs(
        project: ProjectReflection,
        out: string
    ): Promise<void> {
        const start = Date.now();
        out = Path.resolve(out);
        await this.renderer.render(project, out);
        if (this.logger.hasErrors()) {
            this.logger.error(
                "Documentation could not be generated due to the errors above."
            );
        } else {
            this.logger.info(`Documentation generated at ${nicePath(out)}`);
            this.logger.verbose(`HTML rendering took ${Date.now() - start}ms`);
        }
    }

    /**
     * Run the converter for the given set of files and write the reflections to a json file.
     *
     * @param out The path and file name of the target file.
     * @returns Whether the JSON file could be written successfully.
     */
    public async generateJson(
        project: ProjectReflection,
        out: string
    ): Promise<void> {
        const start = Date.now();
        out = Path.resolve(out);
        const eventData = {
            outputDirectory: Path.dirname(out),
            outputFile: Path.basename(out),
        };
        const ser = this.serializer.projectToObject(project, {
            begin: eventData,
            end: eventData,
        });

        const space = this.options.getValue("pretty") ? "\t" : "";
        await writeFile(out, JSON.stringify(ser, null, space));
        this.logger.info(`JSON written to ${nicePath(out)}`);
        this.logger.verbose(`JSON rendering took ${Date.now() - start}ms`);
    }

    /**
     * Print the version number.
     */
    override toString() {
        return [
            "",
            `TypeDoc ${Application.VERSION}`,
            `Using TypeScript ${this.getTypeScriptVersion()} from ${this.getTypeScriptPath()}`,
            "",
        ].join("\n");
    }
}
