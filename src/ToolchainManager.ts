/*
    MIT License

    Copyright (c) 2019 github0null

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
*/

import { ProjectType, CppConfigItem, BuilderConfigData } from "./EIDETypeDefine";
import { File } from "../lib/node-utility/File";
import { SettingManager } from "./SettingManager";
import { ResManager } from "./ResManager";
import { GlobalEvent } from "./GlobalEvents";
import { newMessage, ExceptionToMessage } from "./Message";
import { ARMCodeBuilder } from "./CodeBuilder";
import * as platform from './Platform';

import * as child_process from 'child_process';
import { CmdLineHandler } from "./CmdLineHandler";
import * as fs from 'fs';
import * as events from 'events';
import * as NodePath from 'path';
import * as os from 'os';
import { ICompileOptions, ArmBaseBuilderConfigData } from "./EIDEProjectModules";
import * as utility from "./utility";

export type ToolchainName =
    'SDCC' | 'Keil_C51' | 'IAR_STM8' | 'GNU_SDCC_STM8' | 'COSMIC_STM8' |
    'AC5' | 'AC6' | 'GCC' | 'IAR_ARM' |
    'RISCV_GCC' | 'ANY_GCC' | 'MIPS_GCC' | 'MTI_GCC' | 'None';

export interface IProjectInfo {

    readonly targetName: string;

    toAbsolutePath: (path: string) => string;

    getOutDir: () => string;
}

export interface ToolchainTargetSupportedInfo {

    machine: string;

    archs: string[];

    abis: string[];

    rv_codeModels?: string[];
}

export interface IToolchian {

    readonly name: ToolchainName;

    readonly categoryName: string;

    readonly modelName: string;

    readonly configName: string;

    readonly settingName: string;

    readonly verifyFileName: string;

    readonly excludeViewList?: string[];

    readonly version: number;

    /**
     * get toolchain install folder
     */
    getToolchainDir(): File;

    /**
     * get toolchain executable prefix (optional)
     */
    getToolchainPrefix?: () => string;

    /**
     * get gcc c/c++ compiler path for cpptools
     */
    getGccFamilyCompilerPathForCpptools(): string | undefined;

    /**
     * get compiler internal defines (for cpptools)
     */
    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[];

    /**
     * force append some custom macro
     */
    getCustomDefines(): string[] | undefined;

    /**
     * the system header include path (not be added to compiler params)
     */
    getSystemIncludeList(builderOpts: ICompileOptions): string[];

    /**
     * the default source file include path which will be added in compiler params.
     */
    getDefaultIncludeList(): string[];

    /**
     * force include headers for cpptools intellisence config
     */
    getForceIncludeHeaders(): string[] | undefined;

    /**
     * get gcc target info
    */
    getGccCompilerTargetInfo?: () => ToolchainTargetSupportedInfo | undefined;

    /**
     * update cpptools intellisence config
     */
    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void;

    /**
     * used to show .map.view
    */
    parseMapFile?: (mapFile: string) => string[] | Error;

    // others

    getLibDirs(): string[];

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void;

    getDefaultConfig(): ICompileOptions;

    newInstance(): IToolchian;
}

let _instance: ToolchainManager;

interface ToolchainEnums {
    [type: string]: ToolchainName[];
}

export class ToolchainManager {

    private readonly toolchainNames: ToolchainEnums = {
        'C51': ['Keil_C51', 'SDCC', 'IAR_STM8', 'COSMIC_STM8'],
        'ARM': ['AC5', 'AC6', 'GCC', 'IAR_ARM'],
        'RISC-V': ['RISCV_GCC'],
        'MIPS': ['MTI_GCC'],
        'ANY-GCC': ['ANY_GCC']
    };

    private toolchainMap: Map<ToolchainName, IToolchian>;
    private _event: events.EventEmitter;

    private constructor() {
        this._event = new events.EventEmitter();
        this.toolchainMap = new Map();

        // reload after setting changed
        SettingManager.GetInstance().on('onChanged', (e) => {
            for (const toolchain of this.toolchainMap.values()) {
                if (e.affectsConfiguration(toolchain.settingName)) {
                    this.add(toolchain.newInstance());
                    this.emit('onChanged', toolchain.name);
                }
            }
        });

        // register toolchain
        this.add(new KeilC51());
        this.add(new SDCC());
        this.add(new AC5());
        this.add(new AC6());
        this.add(new GCC());
        this.add(new IARSTM8());
        this.add(new COSMIC_STM8());
        this.add(new RISCV_GCC());
        this.add(new AnyGcc());
        this.add(new IARARM());
        this.add(new MTI_GCC());
    }

    on(event: 'onChanged', listener: (toolchainName: ToolchainName) => void): void;
    on(event: string | symbol, listener: (arg?: any) => void): void {
        this._event.on(event, listener);
    }

    private emit(event: 'onChanged', toolchainName: ToolchainName): boolean;
    private emit(event: string | symbol, arg?: any): boolean {
        return this._event.emit(event, arg);
    }

    static getInstance(): ToolchainManager {
        if (_instance === undefined) { _instance = new ToolchainManager(); }
        return _instance;
    }

    getToolchain(prjType: ProjectType, toolchainName: ToolchainName): IToolchian {

        let res: IToolchian | undefined;

        switch (prjType) {
            case 'RISC-V':
                res = this.toolchainMap.get('RISCV_GCC');
                break;
            case 'ANY-GCC':
                res = this.toolchainMap.get('ANY_GCC');
                break;
            case 'ARM':
                switch (toolchainName) {
                    case 'None':
                        res = this.toolchainMap.get('AC5');
                        break;
                    default:
                        if (this.toolchainNames['ARM'].includes(toolchainName)) {
                            res = this.toolchainMap.get(toolchainName);
                        } else {
                            res = this.toolchainMap.get('AC5');
                            GlobalEvent.emit('msg', newMessage('Warning',
                                'Invalid toolchain name \'' + toolchainName + '\' !, use default toolchain.'));
                        }
                }
                break;
            case 'C51':
                switch (toolchainName) {
                    case 'None':
                        res = this.toolchainMap.get('Keil_C51');
                        break;
                    default:
                        if (this.toolchainNames['C51'].includes(toolchainName)) {
                            res = this.toolchainMap.get(toolchainName);
                        }
                        else {
                            res = this.toolchainMap.get('Keil_C51');
                            GlobalEvent.emit('msg', newMessage('Warning',
                                'Invalid toolchain name \'' + toolchainName + '\' !, use default toolchain.'));
                        }
                }
                break;
            case 'MIPS':
                res = this.toolchainMap.get('MTI_GCC');
                break;
            default:
                throw new Error('Invalid project type \'' + prjType + '\'');
        }

        if (res === undefined) {
            throw new Error('Not found toolchain \'' + toolchainName + '\' for \'' + prjType + '\'');
        }

        return res;
    }

    getToolchainByName(name: ToolchainName): IToolchian | undefined {
        return this.toolchainMap.get(name);
    }

    getToolchainNameList(prjType: ProjectType): ToolchainName[] {
        return this.toolchainNames[prjType];
    }

    getToolchainDesc(name: ToolchainName): string {
        switch (name) {
            case 'AC5':
                return 'ARM C Compiler Version 5';
            case 'AC6':
                return 'ARM C Compiler Version 6';
            case 'Keil_C51':
                return 'Keil C51 Compiler';
            case 'SDCC':
                return 'Small Device C Compiler';
            case 'GCC':
                return 'GNU Arm Embedded Toolchain';
            case 'IAR_ARM':
                return 'IAR ARM C/C++ Compiler';
            case 'IAR_STM8':
                return 'IAR STM8 C/C++ Compiler';
            case 'GNU_SDCC_STM8':
                return 'SDCC With GNU Patch For STM8';
            case 'RISCV_GCC':
                return 'GCC For RISC-V';
            case 'ANY_GCC':
                return 'Any GNU Toolchain';
            case 'COSMIC_STM8':
                return 'COSMIC STM8 C Compiler';
            case 'MTI_GCC':
                return 'MIPS MTI GCC Compiler';
            default:
                return '';
        }
    }

    updateToolchainConfig(configFile: File, toolchain: IToolchian): void {
        try {
            // if exist
            if (configFile.IsFile()) {

                const curOption: ICompileOptions = JSON.parse(configFile.Read());
                const oldVersion: number = curOption.version || 0;

                // if obsoleted, update it
                if (toolchain.version > oldVersion) {

                    const defOptions: ICompileOptions = toolchain.getDefaultConfig();

                    // update version
                    curOption.version = defOptions.version;

                    // compatible some linker old params
                    if (curOption.linker) {
                        // sdcc: rename 'executable-format'
                        if (toolchain.name === 'SDCC' && curOption.linker['executable-format']) {
                            curOption.linker['output-format'] = curOption.linker['executable-format'];
                            curOption.linker['executable-format'] = undefined;
                        }
                        // all: rename 'output-lib'
                        if (curOption.linker['output-lib']) {
                            curOption.linker['output-format'] = 'lib';
                            curOption.linker['output-lib'] = undefined;
                        }
                    }

                    // compatible some c/cpp-compiler old params
                    if (curOption['c/cpp-compiler']) {
                        // armcc5, rename 'c/cpp-compiler'.'misc-control' -> 'c/cpp-compiler'.'C_FLAGS'
                        if (toolchain.name === 'AC5' && curOption['c/cpp-compiler']['misc-control']) {
                            const existedFlags = curOption['c/cpp-compiler']['C_FLAGS'] || '';
                            curOption['c/cpp-compiler']['C_FLAGS'] = curOption['c/cpp-compiler']['misc-control'] + ' ' + existedFlags;
                            curOption['c/cpp-compiler']['misc-control'] = undefined;
                        }
                    }

                    // iar stm8 'code-mode', 'data-mode' has been moved to 'global' from 'c/cpp-compiler'
                    if (curOption["c/cpp-compiler"] && toolchain.name === 'IAR_STM8') {
                        curOption.global['code-mode'] = curOption["c/cpp-compiler"]['code-mode'] || defOptions.global['code-mode'];
                        curOption.global['data-mode'] = curOption["c/cpp-compiler"]['data-mode'] || defOptions.global['data-mode'];
                        curOption["c/cpp-compiler"]['code-mode'] = undefined;
                        curOption["c/cpp-compiler"]['data-mode'] = undefined;
                    }

                    // for gcc, '--specs=xxx' should be global options
                    // ref: https://github.com/github0null/eide/issues/259
                    if (/GCC/.test(toolchain.name) && curOption.linker && typeof curOption.linker['LD_FLAGS'] == 'string') {
                        const specsOpts = curOption.linker['LD_FLAGS'].match(/--specs=[^\s]+/g);
                        if (specsOpts && specsOpts.length > 0) {
                            let optstr = specsOpts.join(' ');
                            // move to global region
                            if (curOption.global == undefined) curOption.global = {};
                            if (curOption.global['misc-control']) {
                                curOption.global['misc-control'] = curOption.global['misc-control'] + ' ' + optstr;
                            } else {
                                curOption.global['misc-control'] = optstr;
                            }
                            // clear them in linker
                            let ldflags = curOption.linker['LD_FLAGS'];
                            specsOpts.forEach(opt => {
                                ldflags = ldflags.replace(opt, '');
                            });
                            curOption.linker['LD_FLAGS'] = ldflags;
                        }
                    }

                    // write to file
                    configFile.Write(JSON.stringify(curOption, undefined, 4));
                }
            } else {
                // write default config to file
                configFile.Write(JSON.stringify(toolchain.getDefaultConfig(), undefined, 4));
            }
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
        }
    }

    getToolchainExecutableFolder(name: ToolchainName): File | undefined {

        const settingManager = SettingManager.GetInstance();

        switch (name) {
            case 'AC5':
                return File.fromArray([settingManager.getArmcc5Dir().path, 'bin']);
            case 'AC6':
                return File.fromArray([settingManager.getArmcc6Dir().path, 'bin']);
            case 'Keil_C51':
                return File.fromArray([settingManager.GetC51Dir().path, 'BIN']);
            case 'GCC':
                return File.fromArray([settingManager.getGCCDir().path, 'bin']);
            case 'IAR_ARM':
                return File.fromArray([settingManager.getIarForArmDir().path, 'bin']);
            case 'IAR_STM8':
                return File.fromArray([settingManager.getIARForStm8Dir().path, 'stm8', 'bin']);
            case 'COSMIC_STM8':
                return settingManager.getCosmicStm8ToolsDir();
            case 'SDCC':
                return File.fromArray([settingManager.getSdccDir().path, 'bin']);
            case 'RISCV_GCC':
                return File.fromArray([settingManager.getRiscvToolFolder().path, 'bin']);
            case 'MTI_GCC':
                return File.fromArray([settingManager.getMipsToolFolder().path, 'bin']);
            case 'GNU_SDCC_STM8':
                return File.fromArray([settingManager.getGnuSdccStm8Dir().path, 'bin']);
            case 'ANY_GCC':
                return File.fromArray([settingManager.getAnyGccToolFolder().path, 'bin']);
            default:
                return undefined;
        }
    }

    getToolchainPrefix(toolchainName: ToolchainName): string | undefined {
        const toolchain = this.toolchainMap.get(toolchainName);
        if (toolchain && toolchain.getToolchainPrefix) {
            return toolchain.getToolchainPrefix();
        }
    }

    isToolchainPathReady(name: ToolchainName): boolean {
        return this.getToolchainExecutableFolder(name)?.IsDir() || false;
    }

    //----------------------

    private add(toolchain: IToolchian) {
        this.toolchainMap.set(toolchain.name, toolchain);
    }
}

class MacroHandler {

    private regMatchers = {
        'normal_macro': /^#define (\w+) (.*)$/,
        'func_macro': /^#define (\w+\([^\)]*\)) (.*)$/
    };

    toExpression(macro: string): string | undefined {

        let mList = this.regMatchers['normal_macro'].exec(macro);
        if (mList && mList.length > 2) {
            return `${mList[1]}=${mList[2]}`;
        }

        mList = this.regMatchers['func_macro'].exec(macro);
        if (mList && mList.length > 2) {
            return `${mList[1]}=`;
        }
    }
}

//=======================================================

class KeilC51 implements IToolchian {

    readonly version = 2;

    readonly settingName: string = 'EIDE.C51.INI.Path';

    readonly verifyFileName: string = '8051.keil.verify.json';

    readonly categoryName: string = 'C51';

    readonly name: ToolchainName = 'Keil_C51';

    readonly modelName: string = '8051.keil.model.json';

    readonly configName: string = '8051.options.keil.json';

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getC51ForceIncludeHeaders().path
        ];
    }

    newInstance(): IToolchian {
        return new KeilC51();
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        //const gcc = File.fromArray([this.getToolchainDir().path, 'BIN', `C51${platform.exeSuffix()}`]);
        //return gcc.path;
        return undefined;
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {
        cppToolsConfig.cStandard = 'c89';
        cppToolsConfig.cppStandard = 'c++98';
    }

    preHandleOptions(prjInfo: IProjectInfo, c51Options: ICompileOptions): void {

        // convert optimization
        if (c51Options["c/cpp-compiler"]) {
            const opType = (<string>c51Options["c/cpp-compiler"]['optimization-type'])?.toUpperCase() || 'SPEED';
            const opLevel = (<string>c51Options["c/cpp-compiler"]['optimization-level'])?.replace('level-', '') || '8';
            c51Options["c/cpp-compiler"]['optimization'] = opLevel + ',' + opType;
        }

        // convert warnings number
        if (c51Options["linker"]) {
            const warnings = (<string[] | undefined>c51Options["linker"]['disable-warnings']);
            if (warnings) {
                c51Options["linker"]['disable-warnings'] = warnings.join(',');
            }
        }

        // convert output lib commmand
        if (c51Options['linker'] && c51Options['linker']['output-format'] === 'lib') {

            // set options
            c51Options['linker']['$use'] = 'linker-lib';

            // create empty lib
            const libFile = new File(prjInfo.getOutDir() + File.sep + prjInfo.targetName + '.LIB');
            if (libFile.IsFile()) {
                try {
                    fs.unlinkSync(libFile.path);
                } catch (error) {
                    GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
                    throw new Error('Delete exist lib failed !, [path]: ' + libFile.path);
                }
            }

            const tmpLib = File.fromArray([ResManager.GetInstance().GetTemplateDir().path, 'C51.LIB']);
            if (!tmpLib.IsFile()) {
                throw new Error('Not found template LIB !, [path]: ' + tmpLib.path);
            }

            try {
                fs.copyFileSync(tmpLib.path, libFile.path);
            } catch (error) {
                GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
                throw new Error('Create empty C51 LIB failed !');
            }
        }
    }

    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {
        return [];
    }

    getCustomDefines(): string[] | undefined {
        return [
            '__UVISION_VERSION=526' /* this is a placeholder !, don't delete it !*/
        ];
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().GetC51Dir();
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        return [];
    }

    getDefaultIncludeList(): string[] {
        return [
            File.fromArray([this.getToolchainDir().path, 'INC']).path
        ];
    }

    getLibDirs(): string[] {
        return [File.fromArray([this.getToolchainDir().path, 'LIB']).path];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "ram-mode": "SMALL",
                "rom-mode": "LARGE"
            },
            'c/cpp-compiler': {
                "optimization-type": "SPEED",
                "optimization-level": "level-8"
            },
            'asm-compiler': {},
            linker: {
                "remove-unused": true,
                "output-format": "elf"
            }
        };
    }
}

class SDCC implements IToolchian {

    readonly version = 3;

    readonly settingName: string = 'EIDE.SDCC.InstallDirectory';

    readonly categoryName: string = 'SDCC';

    readonly name: ToolchainName = 'SDCC';

    readonly modelName: string = 'sdcc.model.json';

    readonly configName: string = 'options.sdcc.json';

    readonly verifyFileName: string = 'sdcc.verify.json';

    private readonly asmMapper: any = {
        "mcs51": "8051",
        "ds390": "390",
        "ds400": "390",
        "hc08": "6808",
        "s08": "6808",
        "r2k": "rab",
        "gbz80": "gb",
        "ez80_z80": "z80"
    };

    newInstance(): IToolchian {
        return new SDCC();
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        //const gcc = File.fromArray([this.getToolchainDir().path, 'bin', `sdcc${platform.exeSuffix()}`]);
        //return gcc.path;
        return undefined;
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {

        cppToolsConfig.cStandard = 'c99';
        cppToolsConfig.cppStandard = 'c++98';

        if (builderOpts["c/cpp-compiler"]) {
            cppToolsConfig.cStandard = builderOpts["c/cpp-compiler"]['language-c'] || 'c99';
        }
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        /* init default */
        if (options["linker"] == undefined) { options["linker"] = {} }
        if (options["asm-compiler"] == undefined) { options["asm-compiler"] = {} }

        /* convert output format */
        if (options['linker']['output-format']) {
            switch (options['linker']['output-format']) {
                case 'lib':
                    options['linker']['$use'] = 'linker-lib';
                    break;
                case 'hex':
                    options['linker']['$use'] = undefined; // hex format
                    break;
                default:
                    options['linker']['$use'] = options['linker']['output-format'];
                    break;
            }
        }

        /* set assembler for sdcc */
        const devName = options.global?.['device'] || 'mcs51';
        const asmName = `sdas${this.asmMapper[devName] || devName}`;
        options["asm-compiler"]['$toolName'] = asmName;
    }

    private parseCodeModel(conf: string): string | undefined {
        const mType = /\s*--model-(\w+)\s*/i.exec(conf);
        if (mType && mType.length > 1) {
            return mType[1];
        }
    }

    private parseProcessor(conf: string): string | undefined {
        const res = /\s*-p(\w+)\s*/i.exec(conf);
        if (res && res.length > 1) {
            return res[1];
        }
    }

    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {

        const mList: string[] = [
            '__SDCC',
            `__SDCC_VERSION_MAJOR=4`,
            `__SDCC_VERSION_MINOR=1`,
            `__SDCC_VERSION_PATCH=0`
        ];

        // code model
        let devName: string = 'mcs51';
        let codeModel: string | undefined;
        let processor: string | undefined;

        // global config
        if (builderOpts.global) {
            const conf = builderOpts.global;

            // get device name
            if (conf['device']) {
                devName = conf['device'];
                mList.push(`__SDCC_${devName}`);
            }

            // get model type
            if (conf['misc-controls']) {
                codeModel = this.parseCodeModel(conf['misc-controls']);
                processor = this.parseProcessor(conf['misc-controls']);
            }

            // is use stack auto 
            if (conf['stack-auto']) {
                mList.push(`__SDCC_STACK_AUTO`);
            }

            // is use xstack 
            if (conf['use-external-stack']) {
                mList.push(`__SDCC_USE_XSTACK`);
            }

            // int long reent
            if (conf['int-long-reent']) {
                mList.push(`__SDCC_INT_LONG_REENT`);
            }

            // float reent
            if (conf['float-reent']) {
                mList.push(`__SDCC_FLOAT_REENT`);
            }
        }

        // cpp config
        if (builderOpts["c/cpp-compiler"]) {
            const conf = builderOpts["c/cpp-compiler"];
            // get model type
            if (conf['misc-controls']) {
                codeModel = this.parseCodeModel(conf['misc-controls']) || codeModel;
            }
        }

        // set processor
        if (processor) {
            // for pic processor
            if (devName.startsWith('pic')) {
                mList.push(`__SDCC_PIC${processor.toUpperCase()}`);
            }
        }

        if (devName == 'ds390') { // set ds390 model
            mList.push(`__SDCC_MODEL_FLAT24`);
        } else if (codeModel) { // set code model
            mList.push(`__SDCC_MODEL_${codeModel.toUpperCase()}`);
        }

        return mList;
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getSdccDir();
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {

        /**
         * This will install sdcc binaries into: /usr/local/bin/
         * header files into:                    /usr/local/share/sdcc/include/
         * non-free header files into:           /usr/local/share/sdcc/non-free/include/
         * library files into:                   /usr/local/share/sdcc/lib/
         * non-free library files into:          /usr/local/share/sdcc/non-free/lib/
         * and documentation into:               /usr/local/share/sdcc/doc/
         * 
         * Try `sdcc --print-search-dirs` if you have problems with header
        */

        let toolSearchLoc: string = this.getToolchainDir().path;
        if (platform.osType() != 'win32') {
            toolSearchLoc = `${toolSearchLoc}/share/sdcc`;
        }

        const incList: string[] = [File.fromArray([toolSearchLoc, 'include']).path];

        let devName: string = 'mcs51';

        if (builderOpts.global) {
            const conf = builderOpts.global;

            // get device name
            if (conf['device']) {
                devName = conf['device'];
                const devInc = File.fromArray([toolSearchLoc, 'include', devName]);
                if (devInc.IsDir()) {
                    incList.push(devInc.path);
                }
            }

            // is use non-free libs
            if (conf['use-non-free']) {
                incList.push(File.fromArray([toolSearchLoc, 'non-free', 'include']).path);
                const devInc = File.fromArray([toolSearchLoc, 'non-free', 'include', devName]);
                if (devInc.IsDir()) {
                    incList.push(devInc.path);
                }
            }
        }

        return incList;
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getC51ForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [File.fromArray([this.getToolchainDir().path, 'lib']).path];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "device": "mcs51",
                "optimize-type": "speed",
                "use-non-free": false
            },
            'c/cpp-compiler': {
                "language-c": "c99"
            },
            'asm-compiler': {},
            linker: {
                "$mainFileName": "main",
                "output-format": "hex"
            }
        };
    }
}

class GnuStm8Sdcc implements IToolchian {

    readonly version = 1;

    readonly settingName: string = 'EIDE.STM8.GNU-SDCC.InstallDirectory';

    readonly categoryName: string = 'SDCC';

    readonly name: ToolchainName = 'GNU_SDCC_STM8';

    readonly modelName: string = 'stm8.gnu-sdcc.model.json';

    readonly configName: string = 'options.stm8.gnu-sdcc.json';

    readonly verifyFileName: string = 'stm8.gnu-sdcc.verify.json';

    newInstance(): IToolchian {
        return new SDCC();
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        //const gcc = File.fromArray([this.getToolchainDir().path, 'bin', `sdcc${platform.exeSuffix()}`]);
        //return gcc.path;
        return undefined;
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {

        cppToolsConfig.cStandard = 'c99';
        cppToolsConfig.cppStandard = 'c++98';

        if (builderOpts["c/cpp-compiler"]) {
            cppToolsConfig.cStandard = builderOpts["c/cpp-compiler"]['language-c'] || 'c99';
        }
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        if (options['linker'] == undefined) {
            options['linker'] = {};
        }

        // convert output lib commmand
        if (options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // get code model
        let codeModel: string = 'medium';
        if (options["c/cpp-compiler"]) {
            const conf = options["c/cpp-compiler"];
            if (conf['misc-controls']) { // get model type
                codeModel = this.parseCodeModel(conf['misc-controls']) || codeModel;
            }
        }

        /* append def linker params */
        {
            const ldFlags: string[] = [];
            const libFlags: string[] = [];

            if (options['linker']['misc-controls']) {
                ldFlags.push(options['linker']['misc-controls']);
            }

            if (options['linker']['LIB_FLAGS']) {
                libFlags.push(options['linker']['LIB_FLAGS']);
            }

            // append default lib search path
            const libDir = File.ToUnixPath(this.getToolchainDir().path + File.sep + `lib-${codeModel}`);
            ldFlags.push(`-L"${libDir}"`);

            // append default system lib
            libFlags.push('-lstm8');

            // set flags
            options['linker']['misc-controls'] = ldFlags.join(' ');
            options['linker']['LIB_FLAGS'] = libFlags.join(' ');
        }
    }

    private parseCodeModel(conf: string): string | undefined {
        const mType = /\s*--model-(\w+)\s*/i.exec(conf);
        if (mType && mType.length > 1) {
            return mType[1];
        }
    }

    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {

        const mList: string[] = [
            '__SDCC',
            `__SDCC_VERSION_MAJOR=3`,
            `__SDCC_VERSION_MINOR=9`,
            `__SDCC_VERSION_PATCH=3`
        ];

        // code model
        let devName: string = 'stm8';
        let codeModel: string = 'medium';

        // fix device name: stm8
        mList.push(`__SDCC_${devName}`);

        // global config
        if (builderOpts["c/cpp-compiler"]) {

            const conf = builderOpts["c/cpp-compiler"];

            // get model type
            if (conf['misc-controls']) {
                codeModel = this.parseCodeModel(conf['misc-controls']) || codeModel;
            }

            // is use stack auto 
            if (conf['stack-auto']) {
                mList.push(`__SDCC_STACK_AUTO`);
            }

            // is use xstack 
            if (conf['use-external-stack']) {
                mList.push(`__SDCC_USE_XSTACK`);
            }

            // int long reent
            if (conf['int-long-reent']) {
                mList.push(`__SDCC_INT_LONG_REENT`);
            }

            // float reent
            if (conf['float-reent']) {
                mList.push(`__SDCC_FLOAT_REENT`);
            }
        }

        if (codeModel) { // set code model
            mList.push(`__SDCC_MODEL_${codeModel.toUpperCase()}`);
        }

        return mList;
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getGnuSdccStm8Dir();
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {

        let toolSearchLoc: string = this.getToolchainDir().path;
        if (platform.osType() != 'win32') {
            toolSearchLoc = `${toolSearchLoc}/share/sdcc`;
        }

        const incList: string[] = [File.fromArray([toolSearchLoc, 'include']).path];

        // get device name include
        const devInc = File.fromArray([toolSearchLoc, 'include', 'stm8']);
        if (devInc.IsDir()) {
            incList.push(devInc.path);
        }

        return incList;
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getC51ForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "out-debug-info": false
            },
            'c/cpp-compiler': {
                "language-c": "c99",
                "optimize-type": "speed",
                "one-elf-section-per-function": true,
                "one-elf-section-per-data": false
            },
            'asm-compiler': {},
            linker: {
                "output-format": "elf",
                "remove-unused-sections": true
            }
        };
    }
}

class COSMIC_STM8 implements IToolchian {

    readonly version = 1;

    readonly settingName: string = 'EIDE.STM8.COSMIC.InstallDirectory';

    readonly categoryName: string = 'COSMIC';

    readonly name: ToolchainName = 'COSMIC_STM8';

    readonly modelName: string = 'stm8.cosmic.model.json';

    readonly configName: string = 'options.stm8-cosmic.json';

    readonly verifyFileName: string = 'stm8.cosmic.verify.json';

    newInstance(): IToolchian {
        return new COSMIC_STM8();
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        // not support
        return undefined;
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {
        cppToolsConfig.cStandard = 'c99';
        cppToolsConfig.cppStandard = 'c++98';
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        /* init default */
        if (options["global"] == undefined) { options["global"] = {} }
        if (options["linker"] == undefined) { options["linker"] = {} }
        if (options["asm-compiler"] == undefined) { options["asm-compiler"] = {} }

        /* setup cxstm8 cfg */
        options['global']['cxstm8-config'] = `"${ResManager.instance().GetAppDataDir().path + File.sep + 'cxstm8.cfg'}"`;

        /* convert output format */
        if (options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // auto include std c libraries
        if (options['linker']['auto-include-stdc-libraries']) {

            let model_suffix = '';
            let codes_suffix = '';
            let model_option = options["global"]['model'] || 'small';

            // for more informations, see CXSTM8_UsersGuide.pdf, page 303
            switch (model_option) {
                case 'small':
                    model_suffix = '';
                    codes_suffix = '';
                    break;
                case 'large':
                    model_suffix = 'l';
                    codes_suffix = '';
                    break;
                case 'small-0':
                    model_suffix = '';
                    codes_suffix = '0';
                    break;
                case 'large-0':
                    model_suffix = 'l';
                    codes_suffix = '0';
                    break;
                default:
                    break;
            }

            // crt libraries
            //  | Startup     | Initialize     | From Table in
            //  | crtsi(0).s  | @near          | @near
            //  | crtsx(0).s  | @near and @far | @near
            //  | crtsif(0).s | @near          | @far
            //  | crtsxf(0).s | @near and @far | @far

            let machineLibs: string[] = [
                // standard ANSI libraries
                `libfs${model_suffix}${codes_suffix}.sm8`, // Float Library
                `libis${model_suffix}${codes_suffix}.sm8`, // Integer Only Library
                `libm${codes_suffix}.sm8`,                 // Machine Library
            ];

            if (options['linker']['LIB_FLAGS'] == undefined) {
                options['linker']['LIB_FLAGS'] = "";
            }

            // append libs
            options['linker']['LIB_FLAGS'] += ' ' + machineLibs.join(' ');
        }
    }

    // start 0000054b end 00000613 length   200 section .info.
    // start ******** end ******** length     0 section .text *** removed ***
    // start 000080f9 end 0000814a length    81 section .text
    private _mapPattern__objSec = /start [^\s]+ end [^\s]+ length \s*(?<size>[^\s]+) section (?<sec>[^\s]+)/;
    private _parseMap(mapPath: string): any {

        const lines = fs.readFileSync(mapPath).toString().split(/\r\n|\n/);

        const objDic: any = {};
        const secList: string[] = [];

        let headerFound = false;
        let currentFile: string | undefined;
        for (let idx = 0; idx < lines.length; idx++) {

            const trimedLine = lines[idx].trim();

            if (headerFound == false && trimedLine == 'Modules') {
                headerFound = true;
                idx++; // skip next line
                continue;
            }

            if (headerFound) {

                if (/^\-+$/.test(trimedLine))
                    break; // end of content

                if (/\.\w+:$/.test(trimedLine)) {
                    currentFile = trimedLine.substr(0, trimedLine.length - 1);
                    objDic[currentFile] = {};
                    continue; // go next line
                }

                if (currentFile) {
                    const m = this._mapPattern__objSec.exec(trimedLine);
                    if (m && m.groups) {
                        const name = m.groups['sec'];
                        const size = parseInt(m.groups['size']);
                        if (['.info.', '.debug'].includes(name)) continue; // skip some unused section
                        if (!secList.includes(name)) secList.push(name);
                        if (objDic[currentFile][name] != undefined) {
                            objDic[currentFile][name] += size;
                        } else {
                            objDic[currentFile][name] = size;
                        }
                    }
                }
            }
        }

        return {
            sections: secList,
            objDic: objDic
        };
    };

    parseMapFile(mapPath: string): string[] | Error {

        if (!File.IsFile(mapPath))
            return new Error(`No such file: ${mapPath}`);

        const mapInfo = this._parseMap(mapPath);
        const secList = mapInfo.sections;
        const objDic = mapInfo.objDic;

        let oldObjDic: any = {};
        if (File.IsFile(mapPath + '.old')) {
            const inf = this._parseMap(mapPath + '.old');
            oldObjDic = inf.objDic;
        }

        const tableRows: string[][] = [];

        // push header
        let header: string[] = [];
        header.push('Module');
        header.push('Size');
        header = header.concat(secList);
        tableRows.push(header);

        let objTotalSize: any = { new: 0, old: 0 };
        let secTotalSize: any = {};
        for (const objpath in objDic) {

            const objInfo = objDic[objpath];
            const row: string[] = [objpath];

            let totalSize = 0;
            for (const key in objInfo) {
                totalSize += objInfo[key];
            }

            let oldInfo: any = {};
            if (oldObjDic[objpath]) {
                oldInfo = oldObjDic[objpath];
            }

            let oldTotalSize = 0;
            for (const key in oldInfo) {
                oldTotalSize += oldInfo[key];
            }

            objTotalSize.new += totalSize;
            objTotalSize.old += oldTotalSize;

            const diffSize = totalSize - oldTotalSize;
            row.push(totalSize.toString() + `(${diffSize > 0 ? '+' : ''}${diffSize.toString()})`);

            for (const sec of secList) {

                const oldSecSize = oldInfo[sec] ? oldInfo[sec] : 0;
                const nowSecSize = objInfo[sec] ? objInfo[sec] : 0;
                const diffSize = nowSecSize - oldSecSize;
                row.push(nowSecSize.toString() + `(${diffSize > 0 ? '+' : ''}${diffSize.toString()})`);

                if (secTotalSize[sec] == undefined) {
                    secTotalSize[sec] = {
                        new: 0,
                        old: 0
                    };
                };

                secTotalSize[sec].new += nowSecSize;
                secTotalSize[sec].old += oldSecSize;
            }

            tableRows.push(row);
        }

        const row_total: string[] = ['Subtotals'];
        {
            const diffSize = objTotalSize.new - objTotalSize.old;
            row_total.push(objTotalSize.new.toString() + `(${diffSize > 0 ? '+' : ''}${diffSize.toString()})`);

            for (const sec of secList) {
                const oldSecSize = secTotalSize[sec].old ? secTotalSize[sec].old : 0;
                const newSecSize = secTotalSize[sec].new ? secTotalSize[sec].new : 0;
                const diffSize = newSecSize - oldSecSize;
                row_total.push(newSecSize.toString() + `(${diffSize > 0 ? '+' : ''}${diffSize.toString()})`);
            }
        }
        tableRows.push(row_total);

        const tableLines = utility.makeTextTable(tableRows);
        if (tableLines == undefined) {
            return new Error(`Nothing for this map: ${mapPath} !`);
        }

        return tableLines;
    }

    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {

        const mList: string[] = [
            '__CSMC__=1'
        ];

        return mList;
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getCosmicStm8ToolsDir();
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        const cxstm8Path = this.getToolchainDir().path;
        return [
            [cxstm8Path, 'Hstm8'].join(File.sep)
        ];
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [];
    }

    getDefaultIncludeList(): string[] {
        const cxstm8Path = this.getToolchainDir().path;
        return [
            [cxstm8Path, 'Hstm8'].join(File.sep)
        ];
    }

    getLibDirs(): string[] {
        return [
            [this.getToolchainDir().path, 'Lib'].join(File.sep)
        ];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "model": "small",
                "output-debug-info": "enable",
                "output-list-file": true
            },
            'c/cpp-compiler': {
                "c99-mode": true,
                "optimization": "size",
                "split-functions": true,
                "warnings": "all"
            },
            'asm-compiler': {},
            'linker': {
                "output-format": 'elf',
                "auto-include-stdc-libraries": true
            }
        };
    }
}

class AC5 implements IToolchian {

    readonly version = 4;

    readonly settingName: string = 'EIDE.ARM.ARMCC5.InstallDirectory';

    readonly categoryName: string = 'ARMCC';

    readonly name: ToolchainName = 'AC5';

    readonly modelName: string = 'arm.v5.model.json';

    readonly configName: string = 'arm.options.v5.json';

    readonly verifyFileName: string = 'arm.v5.verify.json';

    newInstance(): IToolchian {
        return new AC5();
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        //const armccFile = File.fromArray([this.getToolchainDir().path, 'bin', `armcc${platform.exeSuffix()}`]);
        //return armccFile.path;
        return undefined;
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {

        cppToolsConfig.cStandard = 'c89';
        cppToolsConfig.cppStandard = 'c++11';

        if (builderOpts["c/cpp-compiler"]) {

            if (builderOpts["c/cpp-compiler"]['c99-mode']) {
                cppToolsConfig.cStandard = 'c99';
            }

            if (builderOpts["c/cpp-compiler"]['gnu-extensions']) {
                if (cppToolsConfig.cStandard === 'c99') {
                    cppToolsConfig.cStandard = 'gnu99';
                } else {
                    cppToolsConfig.cStandard = 'gnu98';
                }
            }
        }
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {
        // convert output lib commmand
        if (options['linker'] && options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getArmcc5Dir();
    }

    getForceIncludeHeaders(): string[] {
        return [
            ResManager.GetInstance().getArmccForceIncludeHeaders().path
        ];
    }

    //
    // armcc list macros command: 
    //      armcc xxx --list_macros -E - <nul
    //
    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {

        return [];

        //
        // 暂时禁用，c/c++ 插件暂时无法解析某些宏定义
        //

        const cpuMap: { [key: string]: string } = {
            "cortex-m0": "Cortex-M0",
            "cortex-m0+": "Cortex-M0+",
            "cortex-m3": "Cortex-M3",
            "cortex-m4-none": "Cortex-M4 --fpu=SoftVFP",
            "cortex-m4-sp": "Cortex-M4.fp",
            "cortex-m7-none": "Cortex-M7 --fpu=SoftVFP",
            "cortex-m7-sp": "Cortex-M7.fp.sp",
            "cortex-m7-dp": "Cortex-M7.fp.dp",
            "sc000": "SC000",
            "sc300": "SC300"
        };

        const cfg: ArmBaseBuilderConfigData = <any>builderCfg;
        const cpuKey = ARMCodeBuilder.genCpuId(cfg.cpuType.toLowerCase(), cfg.floatingPointHardware);

        try {

            if (cpuMap[cpuKey]) {

                const result: string[] = [];
                const macroParser = new MacroHandler();
                const armccDir = File.fromArray([this.getToolchainDir().path, 'bin']).path;
                const cmdList = [`--cpu ${cpuMap[cpuKey]}`, '--apcs=interwork'];

                if (builderOpts.global) {

                    if (builderOpts['global']['big-endian']) {
                        cmdList.push('--bi');
                    } else {
                        cmdList.push('--li');
                    }

                    if (builderOpts.global['use-microLIB']) {
                        cmdList.push('-D__MICROLIB');
                    }
                }

                if (builderOpts["c/cpp-compiler"]) {

                    if (builderOpts["c/cpp-compiler"]['c99-mode']) {
                        cmdList.push('--c99');
                    }

                    if (builderOpts["c/cpp-compiler"]['gnu-extensions']) {
                        cmdList.push('--gnu');
                    }
                }

                const cmd = `armcc ${cmdList.join(' ')} --list_macros -E - <${platform.osGetNullDev()}`;
                child_process.execSync(cmd, { cwd: armccDir, encoding: 'utf8' })
                    .trim().split(/\r\n|\n/)
                    .forEach((line) => {
                        const expr = macroParser.toExpression(line);
                        if (expr) {
                            result.push(expr);
                        }
                    });

                return result;
            }

        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            return [];
        }

        return [];
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {

        let toolSearchLoc = this.getToolchainDir().path;
        if (platform.osType() != 'win32') {
            toolSearchLoc = `${toolSearchLoc}/share/armcc`
        }

        const incDir = File.fromArray([toolSearchLoc, 'include']);
        if (incDir.IsDir()) {
            return [incDir].concat(incDir.GetList(File.EXCLUDE_ALL_FILTER)).map((f) => { return f.path; });
        }

        return [incDir.path];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [File.fromArray([this.getToolchainDir().path, 'lib']).path];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "use-microLIB": true,
                "output-debug-info": "enable"
            },
            'c/cpp-compiler': {
                "optimization": "level-0",
                "one-elf-section-per-function": true,
                "c99-mode": true,
                "C_FLAGS": "--diag_suppress=1 --diag_suppress=1295",
                "CXX_FLAGS": "--diag_suppress=1 --diag_suppress=1295"
            },
            'asm-compiler': {},
            linker: {
                "output-format": 'elf'
            }
        };
    }
}

class AC6 implements IToolchian {

    readonly version = 3;

    readonly settingName: string = 'EIDE.ARM.ARMCC6.InstallDirectory';

    readonly categoryName: string = 'ARMCC';

    readonly name: ToolchainName = 'AC6';

    readonly modelName: string = 'arm.v6.model.json';

    readonly configName: string = 'arm.options.v6.json';

    readonly verifyFileName: string = 'arm.v6.verify.json';

    /*
    private readonly defMacroList: string[];

    constructor() {
        const armClang = File.fromArray([this.getToolchainDir().path, 'bin', `armclang${platform.exeSuffix()}`]);
        this.defMacroList = this.getMacroList(armClang.path);
    }

    private getMacroList(armClangPath: string): string[] {
        try {
            const cmdLine = CmdLineHandler.quoteString(armClangPath, '"')
                + ' ' + ['--target=arm-arm-none-eabi', '-E', '-dM', '-', `<${osDevNull}`].join(' ');

            const lines = child_process.execSync(cmdLine).toString().split(/\r\n|\n/);
            const resList: string[] = [];
            const mHandler = new MacroHandler();

            lines.filter((line) => { return line.trim() !== ''; })
                .forEach((line) => {
                    const value = mHandler.toExpression(line);
                    if (value) {
                        resList.push(value);
                    }
                });

            return resList;
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            return ['__GNUC__=4', '__GNUC_MINOR__=2', '__GNUC_PATCHLEVEL__=1'];
        }
    }
    */

    newInstance(): IToolchian {
        return new AC6();
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        const armclang = File.fromArray([this.getToolchainDir().path, 'bin', `armclang${platform.exeSuffix()}`]);
        return armclang.path;
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {

        cppToolsConfig.cStandard = 'gnu11';
        cppToolsConfig.cppStandard = 'gnu++98';

        cppToolsConfig.compilerArgs = [
            '--target=arm-arm-none-eabi',
            '-std=${c_cppStandard}'
        ];

        // pass global args for cpptools
        if (builderOpts.global) {

            let cpuType = 'cortex-m3'; // default val

            if (typeof builderOpts.global['cpuType'] == 'string') {
                cpuType = builderOpts.global['cpuType'];
                cppToolsConfig.compilerArgs.push(`-mcpu=${cpuType}`);
            }

            if (typeof builderOpts.global['fpuType'] == 'string') {
                const fpuType = builderOpts.global['fpuType'];
                switch (fpuType) {
                    case 'sp':
                        cppToolsConfig.compilerArgs.push(`-mfpu=fpv5-sp-d16`);
                        break;
                    case 'dp':
                        cppToolsConfig.compilerArgs.push(`-mfpu=fpv5-d16`);
                        break;
                    case 'none':
                        cppToolsConfig.compilerArgs.push(`-mfpu=none`);
                        break;
                    default:
                        break;
                }
                if (['sp', 'dp'].includes(fpuType)) {
                    if (typeof builderOpts.global['$float-abi-type'] == 'string') {
                        const abiType = builderOpts.global['$float-abi-type'];
                        cppToolsConfig.compilerArgs.push(`-mfloat-abi=${abiType}`);
                    }
                }
            }

            if (typeof builderOpts.global['misc-control'] == 'string') {
                const pList = builderOpts.global['misc-control'].trim().split(/\s+/);
                pList.forEach((p) => cppToolsConfig.compilerArgs?.push(p));
            }
        }

        if (builderOpts["c/cpp-compiler"]) {

            if (typeof builderOpts["c/cpp-compiler"]['language-c'] == 'string') {
                cppToolsConfig.cStandard = builderOpts["c/cpp-compiler"]['language-c'];
            }

            if (typeof builderOpts["c/cpp-compiler"]['language-cpp'] == 'string') {
                cppToolsConfig.cppStandard = builderOpts["c/cpp-compiler"]['language-cpp'];
            }

            if (typeof builderOpts["c/cpp-compiler"]['C_FLAGS'] == 'string') {
                const pList = builderOpts['c/cpp-compiler']['C_FLAGS'].trim().split(/\s+/);
                cppToolsConfig.cCompilerArgs = pList;
            }

            if (typeof builderOpts["c/cpp-compiler"]['CXX_FLAGS'] == 'string') {
                const pList = builderOpts['c/cpp-compiler']['CXX_FLAGS'].trim().split(/\s+/);
                cppToolsConfig.cppCompilerArgs = pList;
            }
        }
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        if (options['linker'] === undefined) {
            options['linker'] = Object.create(null);
        }

        // convert output lib commmand
        if (options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // set link time optimization
        if (options['c/cpp-compiler'] && options['c/cpp-compiler']['link-time-optimization']) {
            options['linker']['link-time-optimization'] = options['c/cpp-compiler']['link-time-optimization'];
        }
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getArmcc6Dir();
    }

    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {
        return [];
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {

        let toolSearchLoc = this.getToolchainDir().path;
        if (platform.osType() != 'win32') {
            toolSearchLoc = `${toolSearchLoc}/share/armclang`
        }

        return [
            File.fromArray([toolSearchLoc, 'include']).path,
            File.fromArray([toolSearchLoc, 'include', 'libcxx']).path
        ];
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getArmclangForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [File.fromArray([this.getToolchainDir().path, 'lib']).path];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "use-microLIB": true,
                "output-debug-info": "enable"
            },
            'c/cpp-compiler': {
                "optimization": "level-0",
                "language-c": "c99",
                "language-cpp": "c++11",
                "link-time-optimization": false
            },
            'asm-compiler': {
                "$use": "asm-auto"
            },
            linker: {
                "output-format": 'elf',
                'misc-controls': '--diag_suppress=L6329'
            }
        };
    }
}

class GCC implements IToolchian {

    readonly version = 5;

    readonly settingName: string = 'EIDE.ARM.GCC.InstallDirectory';

    readonly categoryName: string = 'GCC';

    readonly name: ToolchainName = 'GCC';

    readonly modelName: string = 'arm.gcc.model.json';

    readonly configName: string = 'arm.options.gcc.json';

    readonly verifyFileName: string = 'arm.gcc.verify.json';

    constructor() {
        // nothing todo
    }
    /* 
        private getIncludeList(gccDir: string): string[] | undefined {
            try {
                const gccName = this.getToolPrefix() + 'gcc';
                const cmdLine = `${gccName} ` + ['-xc++', '-E', '-v', '-', `<${platform.osGetNullDev()}`, '2>&1'].join(' ');
                const lines = child_process.execSync(cmdLine, { cwd: gccDir }).toString().split(/\r\n|\n/);
                const iStart = lines.findIndex((line) => { return line.startsWith('#include <...>'); });
                const iEnd = lines.indexOf('End of search list.', iStart);
                return lines.slice(iStart + 1, iEnd)
                    .map((line) => { return new File(File.ToLocalPath(line.trim())); })
                    .filter((file) => { return file.IsDir(); })
                    .map((f) => {
                        return f.path;
                    });
            } catch (error) {
                // do nothing
            }
        }
    
        private getMacroList(gccDir: string): string[] | undefined {
            try {
                const gccName = this.getToolPrefix() + 'gcc';
                const cmdLine = `${gccName} ` + ['-E', '-dM', '-', `<${platform.osGetNullDev()}`].join(' ');
                const lines = child_process.execSync(cmdLine, { cwd: gccDir }).toString().split(/\r\n|\n/);
                const results: string[] = [];
                const mHandler = new MacroHandler();
    
                lines.filter((line) => { return line.trim() !== ''; })
                    .forEach((line) => {
                        const value = mHandler.toExpression(line);
                        if (value) {
                            results.push(value);
                        }
                    });
    
                return results;
            } catch (error) {
                // do nothing
            }
        } */

    private getToolPrefix(): string {
        return SettingManager.GetInstance().getGCCPrefix();
    }

    //-----------

    newInstance(): IToolchian {
        return new GCC();
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        const gcc = File.fromArray([this.getToolchainDir().path, 'bin', this.getToolPrefix() + `gcc${platform.exeSuffix()}`]);
        return gcc.path;
    }

    getToolchainPrefix(): string {
        return this.getToolPrefix();
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {

        cppToolsConfig.cStandard = 'c11';
        cppToolsConfig.cppStandard = 'c++11';

        cppToolsConfig.compilerArgs = ['-std=${c_cppStandard}', '-mthumb'];

        // pass global args for cpptools
        if (builderOpts.global) {

            if (typeof builderOpts.global['cpuType'] == 'string') {
                const cpuType = builderOpts.global['cpuType'];
                cppToolsConfig.compilerArgs.push(`-mcpu=${cpuType}`);
            }

            if (typeof builderOpts.global['fpuType'] == 'string') {
                const fpuType = builderOpts.global['fpuType'];
                switch (fpuType) {
                    case 'sp':
                        cppToolsConfig.compilerArgs.push(`-mfpu=fpv5-sp-d16`);
                        break;
                    case 'dp':
                        cppToolsConfig.compilerArgs.push(`-mfpu=fpv5-d16`);
                        break;
                    default:
                        break;
                }
                if (['sp', 'dp'].includes(fpuType)) {
                    if (typeof builderOpts.global['$float-abi-type'] == 'string') {
                        const abiType = builderOpts.global['$float-abi-type'];
                        cppToolsConfig.compilerArgs.push(`-mfloat-abi=${abiType}`);
                    }
                }
            }

            if (typeof builderOpts.global['misc-control'] == 'string') {
                const pList = builderOpts.global['misc-control'].trim().split(/\s+/);
                pList.forEach((p) => cppToolsConfig.compilerArgs?.push(p));
            }
        }

        if (builderOpts["c/cpp-compiler"]) {

            if (builderOpts["c/cpp-compiler"]['language-c']) {
                cppToolsConfig.cStandard = builderOpts["c/cpp-compiler"]['language-c'];
            }

            if (builderOpts["c/cpp-compiler"]['language-cpp']) {
                cppToolsConfig.cppStandard = builderOpts["c/cpp-compiler"]['language-cpp'];
            }

            if (typeof builderOpts["c/cpp-compiler"]['C_FLAGS'] == 'string') {
                const pList = builderOpts['c/cpp-compiler']['C_FLAGS'].trim().split(/\s+/);
                cppToolsConfig.cCompilerArgs = pList;
            }

            if (typeof builderOpts["c/cpp-compiler"]['CXX_FLAGS'] == 'string') {
                const pList = builderOpts['c/cpp-compiler']['CXX_FLAGS'].trim().split(/\s+/);
                cppToolsConfig.cppCompilerArgs = pList;
            }
        }
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        // convert output lib commmand
        if (options['linker'] && options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // if region 'global' is not exist, create it
        if (typeof options['global'] !== 'object') {
            options['global'] = {};
        }

        // set tool prefix
        options['global'].toolPrefix = SettingManager.GetInstance().getGCCPrefix();
    }

    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {
        return [];
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getGCCDir();
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        return [];
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getGccForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "$float-abi-type": 'softfp',
                "output-debug-info": 'enable',
                "misc-control": "--specs=nosys.specs --specs=nano.specs"
            },
            'c/cpp-compiler': {
                "language-c": "c11",
                "language-cpp": "c++11",
                "optimization": 'level-debug',
                "warnings": "all-warnings",
                "one-elf-section-per-function": true,
                "one-elf-section-per-data": true,
                "C_FLAGS": "",
                "CXX_FLAGS": ""
            },
            'asm-compiler': {
                "ASM_FLAGS": ""
            },
            linker: {
                "output-format": "elf",
                "remove-unused-input-sections": true,
                "LD_FLAGS": "",
                "LIB_FLAGS": "-lm"
            }
        };
    }
}

class IARARM implements IToolchian {

    readonly version = 1;

    readonly name: ToolchainName = 'IAR_ARM';

    readonly categoryName: string = 'IAR';

    readonly modelName: string = 'arm.iar.model.json';

    readonly configName: string = 'options.arm.iar.json';

    readonly settingName: string = 'EIDE.IAR.ARM.Toolchain.InstallDirectory';

    readonly verifyFileName: string = 'arm.iar.verify.json';

    newInstance(): IToolchian {
        return new IARARM();
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        return undefined;
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {

        cppToolsConfig.cStandard = 'c99';
        cppToolsConfig.cppStandard = 'c++11';

        if (builderOpts["c/cpp-compiler"]) {
            if (builderOpts["c/cpp-compiler"]['language-c']) {
                cppToolsConfig.cStandard = builderOpts["c/cpp-compiler"]['language-c'];
            }
        }
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        // init null options
        for (const key of ['linker', 'c/cpp-compiler']) {
            if ((<any>options)[key] === undefined) {
                (<any>options)[key] = Object.create(null);
            }
        }

        // convert output lib commmand
        if (options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getIarForArmDir();
    }

    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {
        return [
            '__ICCARM__=1'
        ];
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {

        const iarPath = this.getToolchainDir().path;

        let result: string[] = [
            File.fromArray([iarPath, 'inc']).path,
            File.fromArray([iarPath, 'inc', 'c']).path,
            File.fromArray([iarPath, 'lib']).path
        ];

        if (builderOpts["c/cpp-compiler"]) {
            if (builderOpts["c/cpp-compiler"]['language-cpp'] == 'Extended-EC++') {
                result.push(File.fromArray([iarPath, 'inc', 'ecpp']).path);
            } else { // C++
                result.push(File.fromArray([iarPath, 'inc', 'cpp']).path);
            }
        }

        return result;
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getIarArmForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        const toolDir = this.getToolchainDir();
        return [
            File.fromArray([toolDir.path, 'lib']).path
        ];
    }

    getLibDirs(): string[] {
        const toolDir = this.getToolchainDir();
        return [
            File.fromArray([toolDir.path, 'lib']).path
        ];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "endian-mode": "little",
                "runtime-lib": "normal",
                "printf-formatter": "auto",
                "scanf-formatter": "auto",
                //"math-functions": "default",
                "output-debug-info": "enable"
            },
            'c/cpp-compiler': {
                "optimization": "no",
                "destroy-cpp-static-object": true
            },
            'asm-compiler': {
                "case-sensitive-user-symbols": true
            },
            'linker': {
                "output-format": 'elf',
                "auto-search-runtime-lib": true,
                "perform-cpp-virtual-func-elimination": "enable",
                "config-defines": []
            }
        };
    }
}

class IARSTM8 implements IToolchian {

    readonly version = 5;

    readonly name: ToolchainName = 'IAR_STM8';

    readonly categoryName: string = 'IAR';

    readonly modelName: string = 'stm8.iar.model.json';

    readonly configName: string = 'options.stm8.iar.json';

    readonly settingName: string = 'EIDE.IAR.STM8.InstallDirectory';

    readonly verifyFileName: string = 'stm8.iar.verify.json';

    newInstance(): IToolchian {
        return new IARSTM8();
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        //const gcc = File.fromArray([this.getToolchainDir().path, 'stm8', 'bin', `iccstm8${platform.exeSuffix()}`]);
        //return gcc.path;
        return undefined;
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {

        cppToolsConfig.cStandard = 'c99';
        cppToolsConfig.cppStandard = 'c++11';

        if (builderOpts["c/cpp-compiler"]) {
            if (builderOpts["c/cpp-compiler"]['language-c']) {
                cppToolsConfig.cStandard = builderOpts["c/cpp-compiler"]['language-c'];
            }
        }
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        // init null options
        for (const key of ['linker', 'c/cpp-compiler']) {
            if ((<any>options)[key] === undefined) {
                (<any>options)[key] = Object.create(null);
            }
        }

        // convert output lib commmand
        if (options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // set linker path
        const linkCfgPath_: string | undefined = options.linker['linker-config'];
        if (linkCfgPath_) {
            const linkerCfgPath = linkCfgPath_.trim();
            if (/^[\w-]+\.icf$/i.test(linkerCfgPath)) { // in system icf files
                options.linker['linker-config'] = linkerCfgPath;
            } else { // user icf files
                options.linker['linker-config'] = `"${prjInfo.toAbsolutePath(linkerCfgPath)}"`;
            }
        }

        // set runtime-lib
        const rtLibtype: string | undefined = options["c/cpp-compiler"]['runtime-lib'];
        if (rtLibtype && rtLibtype !== 'null') {
            const mCode: string = (<string>options["c/cpp-compiler"]['code-mode'] || 'small').charAt(0);
            const mData: string = (<string>options["c/cpp-compiler"]['data-mode'] || 'medium').charAt(0);
            const type: string = rtLibtype.charAt(0);
            options["c/cpp-compiler"]['runtime-lib'] = `dlstm8${mCode}${mData}${type}.h`;
        } else {
            options["c/cpp-compiler"]['runtime-lib'] = undefined;
        }
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getIARForStm8Dir();
    }

    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {
        return [];
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        const iarPath = this.getToolchainDir().path;
        return [
            File.fromArray([iarPath, 'stm8', 'inc']).path,
            File.fromArray([iarPath, 'stm8', 'inc', 'c']).path,
            File.fromArray([iarPath, 'stm8', 'inc', 'ecpp']).path,
            File.fromArray([iarPath, 'stm8', 'lib']).path
        ];
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getIarStm8ForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        const toolDir = this.getToolchainDir();
        return [
            File.fromArray([toolDir.path, 'stm8', 'lib']).path
        ];
    }

    getLibDirs(): string[] {
        const toolDir = this.getToolchainDir();
        return [
            File.fromArray([toolDir.path, 'stm8', 'lib']).path
        ];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "data-mode": "medium",
                "code-mode": "small",
                "printf-formatter": "tiny",
                "scanf-formatter": "small",
                "math-functions": "default",
                "output-debug-info": "enable"
            },
            'c/cpp-compiler': {
                "optimization": "no",
                "runtime-lib": "normal",
                "destroy-cpp-static-object": true
            },
            'asm-compiler': {
                "case-sensitive-user-symbols": true
            },
            linker: {
                "output-format": 'elf',
                "linker-config": "lnkstm8s103f3.icf",
                "auto-search-runtime-lib": true,
                "use-C_SPY-debug-lib": true,
                "config-defines": [
                    "_CSTACK_SIZE=0x0200",
                    "_HEAP_SIZE=0x0000"
                ]
            }
        };
    }
}

class MTI_GCC implements IToolchian {

    readonly version = 1;

    readonly settingName: string = 'EIDE.MIPS.InstallDirectory';

    readonly categoryName: string = 'GCC';

    readonly name: ToolchainName = 'MTI_GCC';

    readonly modelName: string = 'mips.mti.gcc.model.json';

    readonly configName: string = 'mips.mti.gcc.options.json';

    readonly verifyFileName: string = 'mips.mti.gcc.verify.json';

    constructor() {
        // nothing todo
    }

    private getToolPrefix(): string {
        return SettingManager.GetInstance().getMipsToolPrefix();
    }

    //-----------

    newInstance(): IToolchian {
        return new MTI_GCC();
    }

    private __lastActivedTargetInfo: ToolchainTargetSupportedInfo | undefined;
    getGccCompilerTargetInfo(): ToolchainTargetSupportedInfo | undefined {

        if (this.__lastActivedTargetInfo)
            return this.__lastActivedTargetInfo;

        const compilerPath = this.getGccFamilyCompilerPathForCpptools();
        if (!compilerPath)
            return undefined;

        try {
            const machine = child_process.execFileSync(compilerPath, ['-dumpmachine']).toString().trim();
            const sysroot = child_process.execFileSync(compilerPath, ['-print-sysroot']).toString().trim();
            const libpath = `${sysroot}/lib`;

            const archs: string[] = fs.readdirSync(libpath)
                .filter(n => n.startsWith('micromipsel-r2') || n.startsWith('mips-r2') || n.startsWith('mipsel-r2'))
                .map(n => n.toLowerCase());

            const lines = child_process.execFileSync(compilerPath, ['-Q', '--help=target'])
                .toString().trim().split(/\r\n|\n/);

            let abis: string[] = [];
            let mods: string[] = [];

            for (let index = 0; index < lines.length; index++) {
                const line = lines[index];
                if (/^\s* Known MIPS ABIs/.test(line)) {
                    abis = lines[index + 1].trim().split(/\s+/);
                } else if (/^\s*Known code models/.test(line)) {
                    mods = lines[index + 1].trim().split(/\s+/);
                }
            }

            const targetInfo: ToolchainTargetSupportedInfo = {
                machine: machine,
                archs: archs,
                abis: abis,
                rv_codeModels: mods
            };

            this.__lastActivedTargetInfo = targetInfo;

            return targetInfo;

        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            return undefined;
        }
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        const gcc = File.fromArray([this.getToolchainDir().path, 'bin', this.getToolPrefix() + `gcc${platform.exeSuffix()}`]);
        return gcc.path;
    }

    getToolchainPrefix(): string {
        return this.getToolPrefix();
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {

        cppToolsConfig.cStandard = 'c11';
        cppToolsConfig.cppStandard = 'c++11';

        cppToolsConfig.compilerArgs = ['-std=${c_cppStandard}'];

        if (builderOpts.global) {

            if (builderOpts.global['arch']) {
                cppToolsConfig.compilerArgs.push(`-march=${builderOpts.global['arch']}`);
            }

            if (builderOpts.global['abi']) {
                cppToolsConfig.compilerArgs.push(`-mabi=${builderOpts.global['abi']}`);
            }

            if (typeof builderOpts.global['float-abi-type'] == 'string') {
                const abiType = builderOpts.global['float-abi-type'];
                if (abiType === 'soft-float') {
                    cppToolsConfig.compilerArgs.push("-msoft-float");
                } else if (abiType === 'hard-float') {
                    cppToolsConfig.compilerArgs.push("-mhard-float");
                }
            }

            const fpuWidth = builderOpts.global['fpu-width'];
            if (fpuWidth === '32') {
                cppToolsConfig.compilerArgs.push("-mfp32");
            } else if (fpuWidth === '64') {
                cppToolsConfig.compilerArgs.push("-mfp64");
            }

            const nanAbi = builderOpts.global['nan-abi'];
            if (nanAbi === '2008') {
                cppToolsConfig.compilerArgs.push("-mnan=2008");
            } else if (fpuWidth === 'legacy') {
                cppToolsConfig.compilerArgs.push("-mnan=legacy");
            }

            const endianness = builderOpts.global['endianness'];
            if (endianness === 'little-endian') {
                cppToolsConfig.compilerArgs.push("-EL");
            } else if (fpuWidth === 'big-endian') {
                cppToolsConfig.compilerArgs.push("-EB");
            }

            if (builderOpts.global['mips16']) {
                cppToolsConfig.compilerArgs.push("-mips16");
            } else {
                cppToolsConfig.compilerArgs.push("-mno-mips16");
            }

            if (builderOpts.global['micromips']) {
                cppToolsConfig.compilerArgs.push("-mmicromips");
            } else {
                cppToolsConfig.compilerArgs.push("-mno-micromips");
            }

            if (builderOpts.global['mcu']) {
                cppToolsConfig.compilerArgs.push("-mmcu");
            } else {
                cppToolsConfig.compilerArgs.push("-mno-mcu");
            }

            // {...|0}: fallback non-numeric values back to "0".
            cppToolsConfig.compilerArgs.push(`-G${builderOpts.global['small-data-size-threshold']|0}`)

            // pass global args for cpptools
            if (typeof builderOpts.global['misc-control'] == 'string') {
                const pList = builderOpts.global['misc-control'].trim().split(/\s+/);
                pList.forEach((p) => cppToolsConfig.compilerArgs?.push(p));
            }
        }

        if (builderOpts["c/cpp-compiler"]) {

            if (builderOpts["c/cpp-compiler"]['language-c']) {
                cppToolsConfig.cStandard = builderOpts["c/cpp-compiler"]['language-c'];
            }

            if (builderOpts["c/cpp-compiler"]['language-cpp']) {
                cppToolsConfig.cppStandard = builderOpts["c/cpp-compiler"]['language-cpp'];
            }

            if (typeof builderOpts["c/cpp-compiler"]['C_FLAGS'] == 'string') {
                const pList = builderOpts['c/cpp-compiler']['C_FLAGS'].trim().split(/\s+/);
                cppToolsConfig.cCompilerArgs = pList;
            }

            if (typeof builderOpts["c/cpp-compiler"]['CXX_FLAGS'] == 'string') {
                const pList = builderOpts['c/cpp-compiler']['CXX_FLAGS'].trim().split(/\s+/);
                cppToolsConfig.cppCompilerArgs = pList;
            }
        }
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        // convert output lib commmand
        if (options['linker'] && options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // if region 'global' is not exist, create it
        if (typeof options['global'] !== 'object') {
            options['global'] = {};
        }

        // set tool prefix
        options['global'].toolPrefix = this.getToolPrefix();
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getMipsToolFolder();
    }

    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {
        return [];
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        return [];
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getGccForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "output-debug-info": 'enable',
                "arch": "mips32r5",
                "abi": "32",
                "float-abi-type": "soft-float",
                "fpu-width": "32",
                "nan-abi": "2008",
                "endianness": "little-endian",
                "mips16": true,
                "micromips": false,
                "mcu": true
            },
            'c/cpp-compiler': {
                "language-c": "c11",
                "language-cpp": "c++11",
                "optimization": 'level-debug',
                "warnings": "all-warnings",
                "one-elf-section-per-function": false,
                "one-elf-section-per-data": false,
                "C_FLAGS": "",
                "CXX_FLAGS": ""
            },
            'asm-compiler': {
                "ASM_FLAGS": ""
            },
            linker: {
                "output-format": "elf",
                "remove-unused-input-sections": true,
                "LD_FLAGS": "-EL",
                "LIB_FLAGS": "-lm -lgcc"
            }
        };
    }
}

class RISCV_GCC implements IToolchian {

    readonly version = 2;

    readonly settingName: string = 'EIDE.RISCV.InstallDirectory';

    readonly categoryName: string = 'GCC';

    readonly name: ToolchainName = 'RISCV_GCC';

    readonly modelName: string = 'riscv.gcc.model.json';

    readonly configName: string = 'riscv.gcc.options.json';

    readonly verifyFileName: string = 'riscv.gcc.verify.json';

    constructor() {
        // nothing todo
    }

    /* 
        private getIncludeList(gccDir: string): string[] | undefined {
            try {
                const gccName = this.getToolPrefix() + 'gcc';
                const cmdLine = `${gccName} ` + ['-xc++', '-E', '-v', '-', `<${platform.osGetNullDev()}`, '2>&1'].join(' ');
                const lines = child_process.execSync(cmdLine, { cwd: gccDir }).toString().split(/\r\n|\n/);
                const iStart = lines.findIndex((line) => { return line.startsWith('#include <...>'); });
                const iEnd = lines.indexOf('End of search list.', iStart);
                return lines.slice(iStart + 1, iEnd)
                    .map((line) => { return new File(File.ToLocalPath(line.trim())); })
                    .filter((file) => { return file.IsDir(); })
                    .map((f) => {
                        return f.path;
                    });
            } catch (error) {
                // nothing todo
            }
        }
    
        private getMacroList(gccDir: string): string[] | undefined {
            try {
                const gccName = this.getToolPrefix() + 'gcc';
                const cmdLine = `${gccName} ` + ['-E', '-dM', '-', `<${platform.osGetNullDev()}`].join(' ');
                const lines = child_process.execSync(cmdLine, { cwd: gccDir }).toString().split(/\r\n|\n/);
                const results: string[] = [];
                const mHandler = new MacroHandler();
    
                lines.filter((line) => { return line.trim() !== ''; })
                    .forEach((line) => {
                        const value = mHandler.toExpression(line);
                        if (value) {
                            results.push(value);
                        }
                    });
    
                return results;
            } catch (error) {
                //GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            }
        } */

    private getToolPrefix(): string {
        return SettingManager.GetInstance().getRiscvToolPrefix();
    }

    //-----------

    newInstance(): IToolchian {
        return new RISCV_GCC();
    }

    private __lastActivedTargetInfo: ToolchainTargetSupportedInfo | undefined;
    getGccCompilerTargetInfo(): ToolchainTargetSupportedInfo | undefined {

        if (this.__lastActivedTargetInfo)
            return this.__lastActivedTargetInfo;

        const compilerPath = this.getGccFamilyCompilerPathForCpptools();
        if (!compilerPath)
            return undefined;

        try {
            const machine = child_process.execFileSync(compilerPath, ['-dumpmachine']).toString().trim();
            const sysroot = child_process.execFileSync(compilerPath, ['-print-sysroot']).toString().trim();
            const libpath = `${sysroot}/lib`;

            const archs: string[] = fs.readdirSync(libpath)
                .filter(n => n.startsWith('rv32') || n.startsWith('rv64'))
                .map(n => n.toLowerCase());

            const lines = child_process.execFileSync(compilerPath, ['-Q', '--help=target'])
                .toString().trim().split(/\r\n|\n/);

            let abis: string[] = [];
            let mods: string[] = [];

            for (let index = 0; index < lines.length; index++) {
                const line = lines[index];
                if (/^\s*Supported ABIs/.test(line)) {
                    abis = lines[index + 1].trim().split(/\s+/);
                } else if (/^\s*Known code models/.test(line)) {
                    mods = lines[index + 1].trim().split(/\s+/);
                }
            }

            const targetInfo: ToolchainTargetSupportedInfo = {
                machine: machine,
                archs: archs,
                abis: abis,
                rv_codeModels: mods
            };

            this.__lastActivedTargetInfo = targetInfo;

            return targetInfo;

        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            return undefined;
        }
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        const gcc = File.fromArray([this.getToolchainDir().path, 'bin', this.getToolPrefix() + `gcc${platform.exeSuffix()}`]);
        return gcc.path;
    }

    getToolchainPrefix(): string {
        return this.getToolPrefix();
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {

        cppToolsConfig.cStandard = 'c11';
        cppToolsConfig.cppStandard = 'c++11';

        cppToolsConfig.compilerArgs = ['-std=${c_cppStandard}'];

        if (builderOpts.global) {

            if (builderOpts.global['arch']) {
                cppToolsConfig.compilerArgs.push(`-march=${builderOpts.global['arch']}`);
            }

            if (builderOpts.global['abi']) {
                cppToolsConfig.compilerArgs.push(`-mabi=${builderOpts.global['abi']}`);
            }

            if (builderOpts.global['code-model']) {
                cppToolsConfig.compilerArgs.push(`-mcmodel=${builderOpts.global['code-model']}`);
            }

            // pass global args for cpptools
            if (typeof builderOpts.global['misc-control'] == 'string') {
                const pList = builderOpts.global['misc-control'].trim().split(/\s+/);
                pList.forEach((p) => cppToolsConfig.compilerArgs?.push(p));
            }
        }

        if (builderOpts["c/cpp-compiler"]) {

            if (builderOpts["c/cpp-compiler"]['language-c']) {
                cppToolsConfig.cStandard = builderOpts["c/cpp-compiler"]['language-c'];
            }

            if (builderOpts["c/cpp-compiler"]['language-cpp']) {
                cppToolsConfig.cppStandard = builderOpts["c/cpp-compiler"]['language-cpp'];
            }

            if (typeof builderOpts["c/cpp-compiler"]['C_FLAGS'] == 'string') {
                const pList = builderOpts['c/cpp-compiler']['C_FLAGS'].trim().split(/\s+/);
                cppToolsConfig.cCompilerArgs = pList;
            }

            if (typeof builderOpts["c/cpp-compiler"]['CXX_FLAGS'] == 'string') {
                const pList = builderOpts['c/cpp-compiler']['CXX_FLAGS'].trim().split(/\s+/);
                cppToolsConfig.cppCompilerArgs = pList;
            }
        }
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        // convert output lib commmand
        if (options['linker'] && options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // if region 'global' is not exist, create it
        if (typeof options['global'] !== 'object') {
            options['global'] = {};
        }

        // set tool prefix
        options['global'].toolPrefix = this.getToolPrefix();
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getRiscvToolFolder();
    }

    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {
        return [];
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        return [];
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getGccForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "output-debug-info": 'enable',
                "arch": "rv32imac",
                "abi": "ilp32",
                "code-model": "medlow",
                "misc-control": "--specs=nosys.specs --specs=nano.specs"
            },
            'c/cpp-compiler': {
                "language-c": "c11",
                "language-cpp": "c++11",
                "optimization": 'level-debug',
                "warnings": "all-warnings",
                "one-elf-section-per-function": true,
                "one-elf-section-per-data": true,
                "C_FLAGS": "-Wl,-Bstatic",
                "CXX_FLAGS": ""
            },
            'asm-compiler': {
                "ASM_FLAGS": "-Wl,-Bstatic"
            },
            linker: {
                "output-format": "elf",
                "remove-unused-input-sections": true,
                "LD_FLAGS": "-Wl,--cref -Wl,--no-relax -nostartfiles",
                "LIB_FLAGS": ""
            }
        };
    }
}

class AnyGcc implements IToolchian {

    readonly version = 1;

    readonly settingName: string = 'EIDE.Toolchain.AnyGcc.InstallDirectory';

    readonly categoryName: string = 'GCC';

    readonly name: ToolchainName = 'ANY_GCC';

    readonly modelName: string = 'any.gcc.model.json';

    readonly configName: string = 'options.any.gcc.json';

    readonly verifyFileName: string = 'any.gcc.verify.json';

    constructor() {
        // nothing todo
    }

    /* private getIncludeList(gccDir: string): string[] | undefined {
        try {
            const gccName = this.getToolPrefix() + 'gcc';
            const cmdLine = `${gccName} ` + ['-xc++', '-E', '-v', '-', `<${platform.osGetNullDev()}`, '2>&1'].join(' ');
            const lines = child_process.execSync(cmdLine, { cwd: gccDir }).toString().split(/\r\n|\n/);
            const iStart = lines.findIndex((line) => { return line.startsWith('#include <...>'); });
            const iEnd = lines.indexOf('End of search list.', iStart);
            return lines.slice(iStart + 1, iEnd)
                .map((line) => { return new File(File.ToLocalPath(line.trim())); })
                .filter((file) => { return file.IsDir(); })
                .map((f) => {
                    return f.path;
                });
        } catch (error) {
            // nothing todo
        }
    }

    private getMacroList(gccDir: string): string[] | undefined {
        try {
            const gccName = this.getToolPrefix() + 'gcc';
            const cmdLine = `${gccName} ` + ['-E', '-dM', '-', `<${platform.osGetNullDev()}`].join(' ');
            const lines = child_process.execSync(cmdLine, { cwd: gccDir }).toString().split(/\r\n|\n/);
            const results: string[] = [];
            const mHandler = new MacroHandler();

            lines.filter((line) => { return line.trim() !== ''; })
                .forEach((line) => {
                    const value = mHandler.toExpression(line);
                    if (value) {
                        results.push(value);
                    }
                });

            return results;
        } catch (error) {
            return undefined;
        }
    } */

    private getToolPrefix(): string {
        return SettingManager.GetInstance().getAnyGccToolPrefix();
    }

    //-----------

    newInstance(): IToolchian {
        return new AnyGcc();
    }

    getGccFamilyCompilerPathForCpptools(): string | undefined {
        const gcc = File.fromArray([this.getToolchainDir().path, 'bin', this.getToolPrefix() + `gcc${platform.exeSuffix()}`]);
        return gcc.path;
    }

    getToolchainPrefix(): string {
        return this.getToolPrefix();
    }

    updateCppIntellisenceCfg(builderOpts: ICompileOptions, cppToolsConfig: CppConfigItem): void {

        const parseLangStd = function (keyName: 'cStandard' | 'cppStandard', pList: string[]) {
            pList.forEach((params) => {
                const m = /-std=([^\s]+)/.exec(params);
                if (m && m.length > 1) { cppToolsConfig[keyName] = m[1]; }
            });
        };

        // pass global args for cpptools
        if (builderOpts.global) {
            if (typeof builderOpts.global['misc-control'] == 'string') {
                const pList = builderOpts.global['misc-control'].trim().split(/\s+/);
                if (!cppToolsConfig.compilerArgs) cppToolsConfig.compilerArgs = [];
                pList.forEach((p) => cppToolsConfig.compilerArgs?.push(p));
            }
        }

        // pass user compiler args
        if (builderOpts["c/cpp-compiler"]) {

            if (typeof builderOpts["c/cpp-compiler"]['C_FLAGS'] == 'string') {
                const pList = builderOpts['c/cpp-compiler']['C_FLAGS'].trim().split(/\s+/);
                cppToolsConfig.cCompilerArgs = pList;
                parseLangStd('cStandard', pList);
            }

            if (typeof builderOpts["c/cpp-compiler"]['CXX_FLAGS'] == 'string') {
                const pList = builderOpts['c/cpp-compiler']['CXX_FLAGS'].trim().split(/\s+/);
                cppToolsConfig.cppCompilerArgs = pList;
                parseLangStd('cppStandard', pList);
            }
        }

        cppToolsConfig.cStandard = cppToolsConfig.cStandard || 'c99';
        cppToolsConfig.cppStandard = cppToolsConfig.cppStandard || 'c++98';
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        // convert output lib commmand
        if (options['linker']) {
            if (options['linker']['linker-type'] == "ld") {
                options['linker']['$use'] = 'linker-ld';
            }
            if (options['linker']['output-format'] == 'lib') {
                options['linker']['$use'] = 'linker-lib';
            }
        }

        // if region 'global' is not exist, create it
        if (typeof options['global'] !== 'object') {
            options['global'] = {};
        }

        // set tool prefix
        options['global'].toolPrefix = this.getToolPrefix();
    }

    getInternalDefines<T extends BuilderConfigData>(builderCfg: T, builderOpts: ICompileOptions): string[] {
        return [];
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getAnyGccToolFolder();
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        return [];
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getGccForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [
                {
                    "name": "make hex",
                    "disable": true,
                    "abortAfterFailed": false,
                    "command": "\"${CompilerFolder}/${CompilerPrefix}objcopy\" -O ihex \"${OutDir}/${TargetName}.elf\" \"${OutDir}/${TargetName}.hex\""
                },
                {
                    "name": "make bin",
                    "disable": true,
                    "abortAfterFailed": false,
                    "command": "\"${CompilerFolder}/${CompilerPrefix}objcopy\" -O binary \"${OutDir}/${TargetName}.elf\" \"${OutDir}/${TargetName}.bin\""
                }
            ],
            global: {},
            'c/cpp-compiler': {
                "one-elf-section-per-function": true,
                "one-elf-section-per-data": true,
                "C_FLAGS": "-c -xc",
                "CXX_FLAGS": "-c -xc++"
            },
            'asm-compiler': {
                "ASM_FLAGS": "-c"
            },
            linker: {
                "output-format": "elf",
                "remove-unused-input-sections": true,
                "LD_FLAGS": "",
                "LIB_FLAGS": ""
            }
        };
    }
}
