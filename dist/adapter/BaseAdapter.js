"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseAdapter = void 0;
const liquibase_1 = __importDefault(require("../liquibase"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ChangeLog_1 = require("../ChangeLog");
const util_1 = require("../util");
const DataLoader_1 = require("../DataLoader");
/**
 * Base class that contains all the shared stuff.
 */
class BaseAdapter {
    /**
     * The constructor
     *
     * @param serviceKey
     * @param options
     */
    constructor(serviceKey, options) {
        this.serviceKey = serviceKey;
        this.options = options;
        this.logger = global.console;
    }
    /*
     * Hooks
     */
    /**
     *
     * @param {ChangeLog} changelog
     */
    beforeDeploy(changelog) {
        // Can be implemented in subclasses
    }
    /*
     * API functions
     */
    /**
     * Drop tables and views from the database. If +dropAll+ is
     * true, then the whole schema is dropped including non CDS
     * tables/views.
     *
     * @param {boolean} dropAll
     */
    async drop({ dropAll = false }) {
        if (dropAll) {
            let liquibaseOptions = this.liquibaseOptionsFor('dropAll');
            await (0, liquibase_1.default)(liquibaseOptions).run('dropAll');
        }
        else {
            await this._dropCdsEntitiesFromDatabase(this.serviceKey, false);
        }
        return Promise.resolve();
    }
    /**
     *
     * @param {boolean} isFullMode
     */
    async load(isFullMode = false) {
        await this.initCds();
        const loader = new DataLoader_1.DataLoader(this, isFullMode);
        // TODO: Make more flexible
        await loader.loadFrom(['data', 'csv']);
    }
    /**
     * Creates a liquibase diff file containing differences between the default
     * and the reference schema.
     *
     * @param {string} outputFile
     */
    async diff(outputFile = null) {
        let keepFile = true;
        await this.initCds();
        await this._deployCdsToReferenceDatabase();
        if (!outputFile) {
            outputFile = 'tmp/diff.txt';
            keepFile = false;
        }
        // run update to create internal liquibase tables
        let liquibaseOptions = this.liquibaseOptionsFor('update');
        liquibaseOptions.defaultSchemaName = this.options.migrations.schema.reference;
        // Revisit: Possible liquibase bug to not support changelogs by absolute path?
        //liquibaseOptions.changeLogFile = `${__dirname}../../template/emptyChangelog.json`
        const tmpChangelogPath = 'tmp/emptyChangelog.json';
        const dirname = path_1.default.dirname(tmpChangelogPath);
        if (!fs_1.default.existsSync(dirname)) {
            fs_1.default.mkdirSync(dirname);
        }
        fs_1.default.copyFileSync(`${__dirname}/../../template/emptyChangelog.json`, tmpChangelogPath);
        liquibaseOptions.changeLogFile = tmpChangelogPath;
        await (0, liquibase_1.default)(liquibaseOptions).run('update');
        fs_1.default.unlinkSync(tmpChangelogPath);
        // create the diff
        liquibaseOptions = this.liquibaseOptionsFor('diff');
        liquibaseOptions.outputFile = outputFile;
        await (0, liquibase_1.default)(liquibaseOptions).run('diff');
        if (!keepFile) {
            const buffer = fs_1.default.readFileSync(liquibaseOptions.outputFile);
            this.logger.log(buffer.toString());
            fs_1.default.unlinkSync(liquibaseOptions.outputFile);
        }
        else {
            this.logger.log(`[cds-dbm] - diff file generated at ${liquibaseOptions.outputFile}`);
        }
    }
    /**
     * Identifies the changes between the cds definition and the database, generates a delta and deploys
     * this to the database.
     * We use a clone and reference schema to identify the delta, because we need to initially drop
     * all the views and we do not want to do this with a potential production database.
     *
     */
    async deploy({ autoUndeploy = false, loadMode = null, dryRun = false, createDb = false }) {
        this.logger.log(`[cds-dbm] - starting delta database deployment of service ${this.serviceKey}`);
        if (createDb) {
            await this._createDatabase();
        }
        await this.initCds();
        const temporaryChangelogFile = `${this.options.migrations.deploy.tmpFile}`;
        if (fs_1.default.existsSync(temporaryChangelogFile)) {
            fs_1.default.unlinkSync(temporaryChangelogFile);
        }
        const dirname = path_1.default.dirname(temporaryChangelogFile);
        if (!fs_1.default.existsSync(dirname)) {
            fs_1.default.mkdirSync(dirname);
        }
        // Setup the clone
        await this._synchronizeCloneDatabase();
        // Drop the known views from the clone
        await this._dropViewsFromCloneDatabase();
        // Create the initial changelog
        let liquibaseOptions = this.liquibaseOptionsFor('diffChangeLog');
        liquibaseOptions.defaultSchemaName = this.options.migrations.schema.default;
        liquibaseOptions.referenceDefaultSchemaName = this.options.migrations.schema.clone;
        liquibaseOptions.changeLogFile = temporaryChangelogFile;
        await (0, liquibase_1.default)(liquibaseOptions).run('diffChangeLog');
        const dropViewsChangeLog = ChangeLog_1.ChangeLog.fromFile(temporaryChangelogFile);
        fs_1.default.unlinkSync(temporaryChangelogFile);
        // Deploy the current state to the reference database
        await this._deployCdsToReferenceDatabase();
        // Update the changelog with the real changes and added views
        liquibaseOptions = this.liquibaseOptionsFor('diffChangeLog');
        liquibaseOptions.defaultSchemaName = this.options.migrations.schema.clone;
        liquibaseOptions.changeLogFile = temporaryChangelogFile;
        await (0, liquibase_1.default)(liquibaseOptions).run('diffChangeLog');
        const diffChangeLog = ChangeLog_1.ChangeLog.fromFile(temporaryChangelogFile);
        // Merge the changelogs
        diffChangeLog.data.databaseChangeLog = dropViewsChangeLog.data.databaseChangeLog.concat(diffChangeLog.data.databaseChangeLog);
        // Process the changelog
        if (!autoUndeploy) {
            diffChangeLog.removeDropTableStatements();
        }
        diffChangeLog.addDropStatementsForUndeployEntities(this.options.migrations.deploy.undeployFile);
        const viewDefinitions = {};
        for (const changeLog of diffChangeLog.data.databaseChangeLog) {
            if (changeLog.changeSet.changes[0].dropView) {
                const viewName = changeLog.changeSet.changes[0].dropView.viewName;
                viewDefinitions[viewName] = await this.getViewDefinition(viewName);
            }
            if (changeLog.changeSet.changes[0].createView) {
                const viewName = changeLog.changeSet.changes[0].createView.viewName;
                viewDefinitions[viewName] = {
                    name: viewName,
                    definition: changeLog.changeSet.changes[0].createView.selectQuery,
                };
            }
        }
        diffChangeLog.reorderChangelog(viewDefinitions);
        // Call hooks
        this.beforeDeploy(diffChangeLog);
        diffChangeLog.toFile(temporaryChangelogFile);
        // Either log the update sql or deploy it to the database
        const updateCmd = dryRun ? 'updateSQL' : 'update';
        liquibaseOptions = this.liquibaseOptionsFor(updateCmd);
        liquibaseOptions.changeLogFile = temporaryChangelogFile;
        liquibaseOptions.defaultSchemaName = this.options.migrations.schema.default;
        const updateSQL = await (0, liquibase_1.default)(liquibaseOptions).run(updateCmd);
        if (!dryRun) {
            this.logger.log(`[cds-dbm] - delta successfully deployed to the database`);
            if (loadMode) {
                await this.load(loadMode.toLowerCase() === 'full');
            }
        }
        else {
            this.logger.log(updateSQL.stdout);
        }
        fs_1.default.unlinkSync(temporaryChangelogFile);
    }
    /*
     * Internal functions
     */
    /**
     * Initialize the cds model (only once)
     */
    async initCds() {
        try {
            this.cdsModel = await cds.load(this.options.service.model);
        }
        catch (error) {
            throw new Error(`[cds-dbm] - failed to load model ${this.options.service.model}`);
        }
        this.cdsSQL = cds.compile.to.sql(this.cdsModel);
        this.cdsSQL.sort(util_1.sortByCasadingViews);
    }
    /**
     * Drops all known views (and tables) from the database.
     *
     * @param {string} service
     */
    async _dropCdsEntitiesFromDatabase(service, viewsOnly = true) {
        const model = await cds.load(this.options.service.model);
        const cdssql = cds.compile.to.sql(model);
        const dropViews = [];
        const dropTables = [];
        for (let each of cdssql) {
            const [, table, entity] = each.match(/^\s*CREATE (?:(TABLE)|VIEW)\s+"?([^\s(]+)"?/im) || [];
            if (!table) {
                dropViews.push({ DROP: { view: entity } });
            }
            if (!viewsOnly && table) {
                dropTables.push({ DROP: { table: entity } });
            }
        }
        const tx = cds.services[service].transaction({});
        await tx.run(dropViews);
        await tx.run(dropTables);
        return tx.commit();
    }
}
exports.BaseAdapter = BaseAdapter;
//# sourceMappingURL=BaseAdapter.js.map