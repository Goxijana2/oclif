import {Interfaces} from '@oclif/core'
import * as path from 'node:path'
import * as fs from 'fs-extra'
import {pipeline} from 'node:stream/promises'
import {log} from '../log'
import {exec as execSync} from 'node:child_process'
import {promisify} from 'util'
import got from 'got'
import * as retry from 'async-retry'
import {checkFor7Zip} from '../util'


const exec = promisify(execSync)

const RETRY_TIMEOUT_MS = 1000

type Options = {
  nodeVersion: string;
  output: string;
  platform: Interfaces.PlatformTypes;
  arch: Interfaces.ArchTypes | 'armv7l';
  tmp: string
}

export async function fetchNodeBinary({nodeVersion, output, platform, arch, tmp}: Options): Promise<string> {
  if (arch === 'arm') arch = 'armv7l'
  let nodeBase = `node-v${nodeVersion}-${platform}-${arch}`
  let tarball = path.join(tmp, 'node', `${nodeBase}.tar.xz`)
  let url = `https://nodejs.org/dist/v${nodeVersion}/${nodeBase}.tar.xz`
  if (platform === 'win32') {
    await checkFor7Zip()
    nodeBase = `node-v${nodeVersion}-win-${arch}`
    tarball = path.join(tmp, 'node', `${nodeBase}.7z`)
    url = `https://nodejs.org/dist/v${nodeVersion}/${nodeBase}.7z`
    output += '.exe'
  }

  let cache = path.join(tmp, 'cache', `node-v${nodeVersion}-${platform}-${arch}`)
  if (platform === 'win32') cache += '.exe'

  const download = async () => {
    log(`downloading ${nodeBase}`)
    await Promise.all([
      fs.ensureDir(path.join(tmp, 'cache', nodeVersion)),
      fs.ensureDir(path.join(tmp, 'node')),
    ])
    const shasums = path.join(tmp, 'cache', nodeVersion, 'SHASUMS256.txt.asc')
    if (!fs.existsSync(shasums)) {
      await pipeline(
        got.stream(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt.asc`),
        fs.createWriteStream(shasums),
      )
    }

    const basedir = path.dirname(tarball)
    await fs.promises.mkdir(basedir, {recursive: true})
    await pipeline(
      got.stream(url),
      fs.createWriteStream(tarball),
    )
    if (platform !== 'win32') await exec(`grep "${path.basename(tarball)}" "${shasums}" | shasum -a 256 -c -`, {cwd: basedir})
  }

  const extract = async () => {
    log(`extracting ${nodeBase}`)
    const nodeTmp = path.join(tmp, 'node')
    await fs.promises.mkdir(nodeTmp, {recursive: true})
    await fs.promises.mkdir(path.dirname(cache), {recursive: true})

    if (platform === 'win32') {
      await exec(`7z x -bd -y "${tarball}"`, {cwd: nodeTmp})
      await fs.move(path.join(nodeTmp, nodeBase, 'node.exe'), path.join(cache, 'node.exe'))
    } else {
      await exec(`tar -C "${tmp}/node" -xJf "${tarball}"`)
      await fs.move(path.join(nodeTmp, nodeBase, 'bin', 'node'), path.join(cache, 'node'))
    }
  }

  if (!fs.existsSync(cache)) {
    await retry(download, {
      retries: 3,
      factor: 1,
      maxTimeout: RETRY_TIMEOUT_MS,
      minTimeout: RETRY_TIMEOUT_MS,
      onRetry(_e, attempt) {
        log(`retrying node download (attempt ${attempt})`)
      },
    })
    await extract()
  }

  await fs.copy(path.join(cache, getFilename(platform)), output)

  return output
}

const getFilename = (platform: string): string => {
  return platform === 'win32' ? 'node.exe' : 'node'
}
