/*
*                      Copyright 2020 Salto Labs Ltd.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
import _ from 'lodash'
import {
  Element, isObjectType, INSTANCE_ANNOTATIONS, ReferenceExpression, ElementMap, ElemID,
} from '@salto-io/adapter-api'
import { collections, values as lowerDashValues } from '@salto-io/lowerdash'
import { logger } from '@salto-io/logging'
import { getAllReferencedIds } from '@salto-io/adapter-utils'
import { FilterCreator } from '../filter'
import { metadataType, apiName } from '../transformers/transformer'
import SalesforceClient from '../client/client'
import { getInternalId, getCustomObjects } from './utils'

const { isDefined } = lowerDashValues
const log = logger(module)

type ElementMapByMetadataType = Record<string, ElementMap>

const STANDARD_ENTITY_TYPES = ['StandardEntity', 'User']

type DependencyDetails = {
  type: string
  id: string
  name: string
}

type DependencyGroup = {
  from: DependencyDetails
  to: DependencyDetails[]
}

/**
 * Get a list of known dependencies between metadata components.
 *
 * @param client  The client to use to run the query
 */
const getDependencies = async (client: SalesforceClient): Promise<DependencyGroup[]> => {
  const allDepsIter = await client.queryAll(
    `SELECT 
      MetadataComponentId, MetadataComponentType, MetadataComponentName, 
      RefMetadataComponentId, RefMetadataComponentType, RefMetadataComponentName 
    FROM MetadataComponentDependency`,
    true,
  )

  const allDepsResult = collections.asynciterable.mapAsync(
    allDepsIter,
    recs => recs.map(rec => ({
      from: {
        type: rec.MetadataComponentType,
        id: rec.MetadataComponentId,
        name: rec.MetadataComponentName,
      },
      to: {
        type: rec.RefMetadataComponentType,
        id: rec.RefMetadataComponentId,
        name: rec.RefMetadataComponentName,
      },
    }))
  )

  const deps = (await collections.asynciterable.toArrayAsync(allDepsResult)).flat()
  return _.values(
    _.groupBy(deps, dep => Object.entries(dep.from))
  ).map(depArr => ({
    from: depArr[0].from,
    to: depArr.map(dep => dep.to),
  }))
}

/**
 * Generate a lookup for elements by metadata type and id.
 *
 * @param elements  The fetched elements
 */
const generateElemLookup = (elements: Element[]): ElementMapByMetadataType => (
  _(elements)
    .flatMap(e => (isObjectType(e) ? [e, ...Object.values(e.fields)] : [e]))
    .filter(e => getInternalId(e) !== undefined && getInternalId(e) !== '')
    .groupBy(metadataType)
    .mapValues(items => _.keyBy(items, item => getInternalId(item)))
    .value()
)

/**
 * Generate a lookup for custom objects by type.
 *
 * @param elements  The fetched elements
 */
const generateCustomObjectLookup = (elements: Element[]): ElementMap => (
  _.keyBy(
    getCustomObjects(elements),
    elem => apiName(elem),
  )
)

/**
 * Add references to the generated-dependencies annotation,
 * except for those already referenced elsewhere.
 *
 * @param elem        The element to modify
 * @param refElemIDs  The reference ids to add
 */
const addGeneratedDependencies = (elem: Element, refElemIDs: ElemID[]): void => {
  if (refElemIDs.length === 0) {
    return
  }

  const existingReferences = getAllReferencedIds(elem)
  const newDependencies = refElemIDs
    .filter(elemId => !existingReferences.has(elemId.getFullName()))
    .map(elemId => new ReferenceExpression(elemId))

  if (newDependencies.length !== 0) {
    elem.annotations[INSTANCE_ANNOTATIONS.GENERATED_DEPENDENCIES] = [
      ...collections.array.makeArray(elem.annotations[INSTANCE_ANNOTATIONS.GENERATED_DEPENDENCIES]),
      ...newDependencies,
    ]
  }
}

/**
 * Add an annotation with the references that are not already represented more granularly
 * in the element.
 *
 * @param groupedDeps         All dependencies, grouped by src
 * @param elemLookup          Element lookup by type and internal salesforce id
 * @param customObjectLookup  Element lookup for custom objects
 */
const addExtraReferences = async (
  groupedDeps: DependencyGroup[],
  elemLookup: ElementMapByMetadataType,
  customObjectLookup: ElementMap,
): Promise<void> => {
  const getElem = ({ type, id }: DependencyDetails): Element | undefined => {
    // Special case handling:
    // - standard entities are returned with type=StandardEntity and id=<entity name>
    // - User is returned with type=User and id=User
    if (STANDARD_ENTITY_TYPES.includes(type)) {
      return customObjectLookup[id]
    }
    return elemLookup[type]?.[id]
  }

  groupedDeps.forEach(edge => {
    const elem = getElem(edge.from)
    if (elem === undefined) {
      log.debug(`Element ${edge.from.type}:${edge.from.id} (${edge.from.name}) not found, skipping ${
        edge.to.length} dependencies`)
      return
    }
    const dependencies = edge.to.map(dst => ({ dep: dst, elem: getElem(dst) }))
    const missingDeps = dependencies.filter(item => item.elem === undefined).map(item => item.dep)
    missingDeps.forEach(dep => {
      log.debug(`Referenced element ${dep.type}:${dep.id} (${dep.name}) not found for ${
        elem.elemID.getFullName()}`)
    })

    addGeneratedDependencies(elem, dependencies.map(item => item.elem?.elemID).filter(isDefined))
  })
}

/**
 * Add references using the tooling API.
 */
const creator: FilterCreator = ({ client }) => ({
  onFetch: async (elements: Element[]) => {
    const groupedDeps = await getDependencies(client)
    const elemLookup = generateElemLookup(elements)
    const customObjectLookup = generateCustomObjectLookup(elements)
    await addExtraReferences(groupedDeps, elemLookup, customObjectLookup)
  },
})

export default creator
