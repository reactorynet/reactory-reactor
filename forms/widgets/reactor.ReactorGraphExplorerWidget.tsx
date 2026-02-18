import { SelectChangeEvent } from '@mui/material/Select';
import Reactory, { React } from '@reactorynet/reactory-core';
import {
  ReactorNode, ReactorNodeAttribute,
} from '@reactory/server-modules/reactory-reactor/types/model.types';

interface ReactorGraphExplorerWidgetUIOptions {
  search: boolean,
  query: string,
  width: number,
  height: number,
  refreshEvents: any[],
  resultMap: {
    [key: string]: string
  },
  variables: {
    [key: string]: string
  },
}

interface ReactorGraphExplorerProperties {
  reactory: Reactory.Client.ReactorySDK,
  [key: string]: any

}

const DEFAULT_OPTIONS = {
  query: '',
  refreshEvents: [],
  resultMap: {},
  variables: {},
  width: 500,
  height: 500,
}

/**
 * interface specification for ForDirectedGraphNodes
 * 
 * Each node must be an object. 
 * The following properties are assigned by the simulation:
    index - the node’s zero-based index into nodes
    x - the node’s current x-position
    y - the node’s current y-position
    vx - the node’s current x-velocity
    vy - the node’s current y-velocity
 */
interface ForceDirectedGraphNode {
  index: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  [key: string]: any
}

interface ForceDirectedGraphLink {
  source: ForceDirectedGraphNode,
  target: ForceDirectedGraphNode,
  [key: string]: any
}

interface SelectedNodeMap {
  [key: string]: ForceDirectedGraphNode
}

interface SelectedNodePropsMap {
  [key: string]: any
}

export const ReactorGraphExplorer = (props: ReactorGraphExplorerProperties) => {
  const { formData, schema, uiSchema, reactory, formContext } = props;
  const { React, Material, Package, FullScreenModal } = reactory.getComponents<{
    React: Reactory.React,
    Material: Reactory.Client.Web.IMaterialModule,
    Package: Reactory.Client.Web.D3Package,
    FullScreenModal: React.FC,
    ThreeFiber: Reactory.Client.Web.ThreeFiber,
    ReactThree: Reactory.Client.Web.ReactThree,
    Three: Reactory.Client.Web.Three
  }>([
    'react.React',
    'material-ui.Material',
    'd3.Package',
    'core.FullScreenModal',
    'three.ThreeFiber',
    'three.ReactThree',
    'three.Three'
  ]);
  const ctx: Reactory.Client.IReactoryFormContext<any> = formContext;
  const { MaterialCore, MaterialStyles, MaterialIcons } = Material;
  const { graphqlQuery: query, graphqlMutation: mutate, utils, log, getUser } = reactory;
  const { merge } = utils.objectMapper;
  const { uniqBy } = utils.lodash;
  const { makeStyles } = MaterialStyles;
  const user = getUser();
  const {
    Box,
    Typography,
    Grid,
    Chip,
    Toolbar,
    IconButton,
    Menu,
    MenuItem,
    FormControl,
    Select,
    InputLabel,
    OutlinedInput,
  } = MaterialCore;
  const { useState, useEffect, useRef, Fragment } = React;
  const [graph, setGraph] = useState<any>(null);
  const { d3, d3Array, d3Cloud, d3Force } = Package;
  const [notified, setNotified] = useState<boolean>(false);
  const [graphData, setGraphDataProxy] = useState<{ nodes: ForceDirectedGraphNode[], links: ForceDirectedGraphLink[] }>({ links: [], nodes: [] });
  const [selected, setSelected] = useState<SelectedNodeMap>({});
  const [expanded, setExpanded] = useState<SelectedNodeMap>({});
  const [selectedLink, setSelectedLink] = useState<ForceDirectedGraphLink>(null);
  const [selectedNodeProps, setSelectNodeProps] = useState<SelectedNodePropsMap>({});
  const [catalogs, setCatalogs] = useState<ReactorNode[]>([]);
  const [selectedCatalogs, setSelectedCatalogs] = useState<string[]>([]);
  const [categories, setCategories] = useState<ReactorNode[]>([]);
  const [paging, setPaging] = useState<{ key: string, paging: Reactory.Models.IPagedResponse<any> }[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState<boolean>(false);
  const [keyPressed, setKeyPressed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [activeForm, setActiveForm] = useState<{ id: string, props: any, title: string, node: ForceDirectedGraphNode }>(null);
  const [listenersBound, setListenersBound] = useState<boolean>(false);
  const [runSimualation, setRunSimulation] = useState<boolean>(false);
  const [saving, setIsSaving] = useState<boolean>(false);
  const [modelName, setModelName] = useState<string>(`${user.loggedIn.user.firstName}'s perspective`);
  const [searchText, setSearchText] = useState<string>();

  const saveGraph = () => {
    try {
      setIsSaving(true);
      if (graphData?.nodes.length === 0 && graphData?.links.length === 0) {
        setIsSaving(false);
        return;
      }
      reactory.graphqlMutation(`mutation ReactorSaveSystemGraph($graph: ReactorSystemGraphInput!) { 
        ReactorSaveSystemGraph(graph: $graph) {
          ... on ReactorSystemGraphSaveSuccess {
            success
            message
          }
          ... on ReactorSystemGraphSaveFailure {
            id
            error
          }
        }
      }`, { graph: graphData }).then((result) => {
        try {
          if (result.errors && result.errors.length > 0) {
            reactory.createNotification(`Error saving graph: ${result.errors.join(', ')}`, 'error')
            log('saveGraph GraphQL errors', result.errors, 'error');
          }

          if (result.data) {
            log('Saved Graph', { result });
          }
        } catch (err) {
          log('saveGraph result processing error', err, 'error');
        }
      }).catch((err) => {
        log('saveGraph GraphQL mutation error', err, 'error');
        setError(err?.message || err?.toString() || 'Unknown Error');
      }).finally(() => {
        setIsSaving(false);
      });
    } catch (err) {
      log('saveGraph function error', err, 'error');
      setIsSaving(false);
    }
  }

  const setGraphData = (data: { nodes: ForceDirectedGraphNode[], links: ForceDirectedGraphLink[] }) => {

    const nextNodes = uniqBy([...data.nodes], 'id');
    let nextLinks = [...data.links];

    log('Set Graph Data', { data, nextNodes })

    setGraphDataProxy({ nodes: nextNodes, links: nextLinks });
  }

  // Event handlers for key events
  const handleKeyDown = (event: KeyboardEvent) => {

    log('handleKeyDown', { event });
    if (event.key === "Shift") {
      setKeyPressed(true);
    }
  };

  const handleKeyUp = (event: KeyboardEvent) => {

    log('handleKeyUp', event);
    if (event.key === "Shift") {
      setKeyPressed(false);
    }
  };


  const options: ReactorGraphExplorerWidgetUIOptions = uiSchema['ui:options'] || DEFAULT_OPTIONS;
  const { graphql } = ctx.formDef;


  const root: ForceDirectedGraphNode = {
    id: 'root',
    nameSpace: 'zepz',
    name: 'maindb',
    version: '1.0.0',
    vx: 0, vy: 0, x: 0, y: 0, index: 0
  };

  const svgRef = useRef();


  // const getCategories = () => { 
  //   setLoading(true);
  //   try{
  //     const queryDef = graphql.queries['categoriesQuery'];
  //     query(queryDef.text, merge({ formData, formContext, props: queryDef.props || {} }, options.variables)).then((result: any) => {
  //       if(result.errors && result.errors.length > 0) { 
  //         setError(result.errors.join(', '));
  //       }
  //       if(result.data) {
  //         //@ts-ignore
  //         const $data = merge(result.data[queryDef.name], queryDef.resultMap);
  //         log('Got Data', { $data });
  //         setCatalogs($data);
  //       }
  //     }).catch((err: any) => { 
  //       setError(err?.message || err?.toString() || 'Unknown Error');
  //     }).finally(() => { 
  //       setLoading(false);
  //     });
  //   } catch(err) { 
  //     setError(err?.message || err?.toString() || 'Unknown Error');
  //   }
  // }

  const getCatalogs = async () => {
    setLoading(true);
    try {
      log('Loading catalogs', { options });
      const queryDef = graphql.queries['catalogsQuery'];
      if (!queryDef) {
        setError('Catalogs query definition is missing.');
        return;
      }
      const result = await query(queryDef.text, merge({ formData, formContext, props: queryDef.props || {} }, options.variables));
      if (!result) {
        setError('No response from server.');
        return;
      }
      if (result.errors && result.errors.length > 0) {
        setError(result.errors.join(', '));
        log('getCatalogs error', result.errors, 'error');
      }
      if (result.data) {
        //@ts-ignore 
        const $data = merge(result.data[queryDef.name], queryDef.resultMap);
        log('Got Catalogs', { $data });
        setCatalogs($data || []);

        // check if the query object has a root property
        if (reactory.queryObject && Object.keys(reactory.queryObject).indexOf('root') > -1) {
          const root = reactory.queryObject['root'];
          log('Got Root', { root });
          if (typeof root === 'string' && root.indexOf(",") > -1) {
            let keys = root.split(',');
            setSelectedCatalogs(keys);
          } else if (root) {
            setSelectedCatalogs([root]);
          }
        }
      } else {
        setError('No data returned from server.');
      }
    } catch (e) {
      setError(e?.message || e?.toString() || 'Unknown Error');
      log('getCatalogs exception', e, 'error');
    } finally {
      setLoading(false);
    }
  }

  const getData = async (node: ReactorNode = {}): Promise<ReactorNode> => {
    try {
      if (!node || !node.id) {
        setError('Invalid node provided for data fetch.');
        return node;
      }
      log('Getting Data', { options, formData, formContext, props });
      const queryDef = graphql.queries["nodeChildrenQuery"];
      if (!queryDef) {
        setError('Node children query definition is missing.');
        return node;
      }
      let inputItem = { formData, formContext, options, node, props: { ...queryDef?.props } || {}, parent };
      let variables = merge(inputItem, queryDef.variables);
      log('Query Variables', { variables, inputItem, queryDef }, 'info');
      const result = await query(queryDef.text, merge(inputItem, queryDef.variables));
      if (!result) {
        setError('No response from server.');
        return node;
      }
      if (result.errors && result.errors.length > 0) {
        setError(result.errors.join(', '));
        log('getData error', result.errors, 'error');
        return node;
      }
      if (result.data) {
        //@ts-ignore
        log(`Results for node`, { node, result, queryDef });
        let $data = merge(result.data[queryDef.name], queryDef.resultMap) as ReactorNode;
        log('After conversion', { $data });
        if (typeof $data === 'object' && $data.id === node.id) {
          return $data;
        }
        return node;
      }
      setError('No data returned for node.');
      return node;
    } catch (err) {
      log('getData exception', err, 'error');
      setError(err?.message || err?.toString() || 'Unknown Error');
      return node;
    }
  }

  const bindEventListeners = () => {
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    // setListenersBound(true);
  }

  const unbindEventListeners = () => {
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('keyup', handleKeyUp);
    //setListenersBound(false);

  }

  useEffect(() => {
    // we want to filter out the children of the selected node(s) where
    // and hide the children where the name doesn't match the search text
    // we will also hide the children of the children

    const {
      nodes,
      links
    } = graphData;

    // get the selected nodes
    const selectedNodes = Object.values(selected);
    const selectedNodeIds = selectedNodes.map((node) => node.id);

    // get the children of the selected nodes
    const children = links.filter((link) => selectedNodeIds.indexOf(link.source.id) > -1);
    const childNodeIds = children.map((link) => link.target.id);

    // get the children of the children
    const grandChildren = links.filter((link) => childNodeIds.indexOf(link.source.id) > -1);
    const grandChildNodeIds = grandChildren.map((link) => link.target.id);

    // remove the children from the graph data where the name doesn't match the search text
    const filteredNodes = nodes.filter((node) => {
      if (node.name.toLowerCase().indexOf(searchText.toLowerCase()) > -1) {
        // name matches the search text
        if (childNodeIds.indexOf(node.id) > -1) return false;
        if (grandChildNodeIds.indexOf(node.id) > -1) return false;

        return true;
      }

      return true;
    });

    // remove the links that are not connected to the filtered nodes
    const filteredLinks = links.filter((link) => {
      if (filteredNodes.find((node) => node.id === link.source.id) || filteredNodes.find((node) => node.id === link.target.id)) {
        return true;
      }
      return false;
    });

    setGraphData({ nodes: filteredNodes, links: filteredLinks });


  }, [searchText])

  useEffect(() => {
    getCatalogs();

    log('useEffect[] triggering bindEventListeners', { listenersBound });
    bindEventListeners();

    // Clean up
    return () => {
      log('useEffect triggering unbindEventListeners', { listenersBound });
      unbindEventListeners();
    };
  }, []);

  //async use effect loader to fetch data for selected catalogs


  useEffect(() => {
    const loadData = async () => {
      setLoading(true);

      const $nodes: ReactorNode[] = [];
      const $links: ReactorNode[] = [];

      // Use Promise.all to wait for all async operations to complete
      await Promise.all(selectedCatalogs.map(async (name) => {
        const node = catalogs.find((elem) => elem.name === name);
        if (node) {
          $nodes.push(node);
          //only if node is exanded we load the children 
          if (node.id in expanded) {
            const nodeData = await getData(node);
            log('Loaded Children For Node', { node: nodeData })
            if (nodeData.children && nodeData.children.length > 0) {
              nodeData.children.forEach((child) => {
                $links.push({
                  source: nodeData.id,
                  target: child.id,
                  index: child.index,
                  type: 'child',
                  value: 1
                });
                $nodes.push({ ...child })
              });
            }
          }
        }
      }));

      log('Got Nodes', { $nodes, $links });

      // Once all async operations are completed, update the states
      setGraphData({ links: [...graphData.links, ...$links], nodes: uniqBy($nodes, 'id') });
      setLoading(false);
    };

    loadData(); // Call the async function
  }, [selectedCatalogs]); // Dependencies array

  useEffect(() => {
    // Disable automatic saving to prevent cascade failures
    // Save will be triggered manually or on specific user actions
    // TODO: Re-enable once GraphQL save endpoint is fixed
    // saveGraph();
    log('Graph data changed - auto-save disabled due to GraphQL errors', {
      nodeCount: graphData.nodes.length,
      linkCount: graphData.links.length
    });
  }, [graphData.nodes, graphData.links, modelName]);


  const { width = 500, height = 500 } = options;
  let child = null;


  const onNodeClickedEventHandler = (node: ForceDirectedGraphNode, event: PointerEvent) => {
    try {
      log('onNodeClickedEventHandler START', {
        nodeId: node.id,
        nodeName: node.name,
        currentSelected: Object.keys(selected),
        keyPressed,
        shiftKey: event.shiftKey
      });

      // Always prevent event bubbling
      event.stopPropagation();

      // Check for shift key from both our state and the event
      const isMultiSelect = keyPressed || event.shiftKey;

      if (isMultiSelect) {
        // Multi-select mode (Shift key held down)
        // Use functional state update to get current state
        setSelected((currentSelected: SelectedNodeMap) => {
          if (currentSelected[node.id]) {
            // Node is already selected, remove it from selection
            log('Removing from selection', { nodeId: node.id, nodeName: node.name });
            const newSelected = { ...currentSelected };
            delete newSelected[node.id];
            log('Setting new selection (removed)', { newSelected: Object.keys(newSelected) });
            return newSelected;
          } else {
            // Node is not selected, add it to selection
            log('Adding to selection', { nodeId: node.id, nodeName: node.name });
            const newSelected = { ...currentSelected, [node.id]: node };
            log('Setting new selection (added)', { newSelected: Object.keys(newSelected) });
            return newSelected;
          }
        });
      } else {
        // Single-select mode (no modifier key)
        // Use functional state update to get current state
        setSelected((currentSelected: SelectedNodeMap) => {
          if (currentSelected[node.id]) {
            // Node is selected, check if it's the only one or if there are multiple
            if (Object.keys(currentSelected).length === 1) {
              // Node is the only selected node, deselect it
              log('Deselecting single node', { nodeId: node.id, nodeName: node.name });
              return {};
            } else {
              // Multiple nodes selected, clear all and select only this one
              log('Clearing multi-selection and setting single node', { nodeId: node.id, nodeName: node.name });
              return { [node.id]: node };
            }
          } else {
            // Node is not selected, clear all selections and select only this node
            log('Clearing selection and setting single node', { nodeId: node.id, nodeName: node.name });
            return { [node.id]: node };
          }
        });
      }

      log('onNodeClickedEventHandler END', {
        nodeId: node.id
      });
    } catch (error) {
      log('onNodeClickedEventHandler error', { error, node, event }, 'error');
      // Don't let errors break the selection - just log and continue
    }
  };

  const onNodeDoubleClickEventHandler = (node: ForceDirectedGraphNode, event: PointerEvent) => {
    log('onNodeDoubleClickEventHandler', { node, event });
  }

  const roots: ReactorNode[] = [];

  const onSystemsChanged = (evt: SelectChangeEvent) => {
    log('onSystemsChanged', { evt });
    //@ts-ignore
    setSelectedCatalogs(evt.target.value as string[]);
  }

  const ITEM_HEIGHT = 48;
  const ITEM_PADDING_TOP = 8;


  /**
   * 
   * @returns 
   */
  const drawAndRunSimulation = () => {
    if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.links)) {
      log('drawAndRunSimulation: Invalid graphData', { graphData }, 'error');
      return;
    }
    const nodes = [...graphData.nodes];
    const links = [...graphData.links];
    let width = 800;
    try {
      width = reactory.getSizeSpec().innerWidth - 40;
    } catch (e) {
      log('drawAndRunSimulation: getSizeSpec error', e, 'error');
    }
    const height = 600;
    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height);

    svg.selectAll('*').remove();

    // Defensive: skip if no nodes or links
    if (!Array.isArray(nodes) || !Array.isArray(links)) return;

    // Initialize force simulation with minimal forces to keep nodes stable
    let simulation;
    try {
      // Helper function to check if two nodes overlap
      const nodesOverlap = (x1: number, y1: number, x2: number, y2: number, minDistance = 60) => {
        const dx = x1 - x2;
        const dy = y1 - y2;
        return Math.sqrt(dx * dx + dy * dy) < minDistance;
      };

      // Helper function to find a non-overlapping position
      const findNonOverlappingPosition = (centerX: number, centerY: number, existingNodes: any[]) => {
        let angle = 0;
        let radius = 50;
        const maxRadius = Math.min(width, height) / 3;
        const angleStep = Math.PI / 6; // 30 degrees

        while (radius <= maxRadius) {
          const x = centerX + radius * Math.cos(angle);
          const y = centerY + radius * Math.sin(angle);

          // Check if this position overlaps with any existing node
          const overlaps = existingNodes.some(node =>
            nodesOverlap(x, y, node.x || node.fx, node.y || node.fy)
          );

          if (!overlaps) {
            return { x, y };
          }

          // Move to next angle position
          angle += angleStep;

          // If we've gone full circle, increase radius and reset angle
          if (angle >= 2 * Math.PI) {
            angle = 0;
            radius += 50;
          }
        }

        // Fallback if no position found
        return { x: centerX, y: centerY };
      };

      // Position nodes with proper collision detection
      const centerX = width / 2;
      const centerY = height / 2;
      const positionedNodes: any[] = [];

      nodes.forEach((node, index) => {
        // Check if this node already has a fixed position from previous renders
        const existingNode = graphData.nodes.find(n => n.id === node.id);

        if (existingNode && existingNode.fx !== undefined && existingNode.fy !== undefined) {
          // Use the existing fixed position
          node.x = existingNode.fx;
          node.y = existingNode.fy;
          node.fx = existingNode.fx;
          node.fy = existingNode.fy;
          positionedNodes.push(node);
        } else if (node.x !== undefined && node.y !== undefined && node.fx !== undefined && node.fy !== undefined) {
          // Node has fixed coordinates, keep them
          node.fx = node.x;
          node.fy = node.y;
          positionedNodes.push(node);
        } else {
          // New node without position - find a good spot
          let newPos;
          if (positionedNodes.length === 0) {
            // First node goes to center
            newPos = { x: centerX, y: centerY };
          } else {
            // Find non-overlapping position for subsequent nodes
            newPos = findNonOverlappingPosition(centerX, centerY, positionedNodes);
          }

          node.x = newPos.x;
          node.y = newPos.y;
          node.fx = newPos.x;
          node.fy = newPos.y;
          positionedNodes.push(node);
        }
      });

      simulation = d3.forceSimulation(nodes)
        // Remove most forces to keep nodes stable
        .force('link', null) // Disable link forces
        .force('charge', null) // Disable charge forces  
        .force('center', null) // Disable center forces
        .alphaTarget(0) // Stop simulation immediately
        .alphaDecay(1); // Fast decay to stop quickly
    } catch (e) {
      log('drawAndRunSimulation: simulation error', e, 'error');
      return;
    }

    // Create link elements
    const link = svg.append('g')
      .attr('stroke', '#FFF')
      .attr('stroke-opacity', 0.6)
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('style', (d) => {
        try {
          if (d && d.source && d.target && d.source.id === selectedLink?.source?.id && d.target.id === selectedLink?.target?.id) {
            return 'cursor: pointer; stroke: red; stroke-width: 2px;';
          }
        } catch (e) { }
        return 'cursor: pointer; stroke: #999; stroke-width: 2px;';
      })
      .attr('stroke-width', (d) => Math.sqrt(d.value || 1))
      .attr('stroke', (d) => {
        try {
          return d.source.id === selectedLink?.source?.id && d.target.id === selectedLink?.target?.id ? 'red' : '#999';
        } catch (e) { return '#999'; }
      });

    link.distance = (d) => d.distance || 200;
    link.strength = (d) => d.strength || 0.1;

    // add a click event handler for the link
    link.on('click', (event, d) => {
      try {
        log('Link Clicked', { event, d });
        event.stopPropagation();
        if (selectedLink && selectedLink.source?.id === d.source?.id && selectedLink.target?.id === d.target?.id) {
          setSelectedLink(null);
          return;
        }
        setSelectedLink(d);
      } catch (e) {
        log('drawAndRunSimulation: link click error', e, 'error');
      }
    });

    // Create node elements with conditional rendering based on node type
    const node = svg.append('g')
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .selectAll('g')
      .data(nodes)
      .join('g')
      .each(function (d) {
        try {
          const selection = d3.select(this);
          const icon = d.attributes?.find(attr => attr.key === "icon")?.value;
          if (icon && icon.type === "svg" && icon.svg) {
            selection.append('g')
              .attr('transform', 'translate(-16, -16)')
              .html(icon.svg);
          } else if (icon && icon.type === "icon") {
            selection.html(`<span class="material-symbols-outlined">${icon.icon}</span>`);
          } else {
            // Render a rectangular box instead of circle for default nodes
            selection.append('rect')
              .attr('x', -20)
              .attr('y', -12)
              .attr('width', 40)
              .attr('height', 24)
              .attr('rx', 4) // rounded corners
              .attr('ry', 4)
              .attr('fill', '#2196F3')
              .attr('stroke', '#fff')
              .attr('stroke-width', 2);
          }

          // Center-aligned text label
          selection.append('text')
            .attr('x', 0) // Center horizontally
            .attr('y', 35) // Position below the node
            .attr('text-anchor', 'middle') // Center align text
            .attr('dominant-baseline', 'central') // Center align vertically
            .attr('font-weight', 'normal') // Remove bold styling
            .attr('font-size', '12px')
            .attr('fill', '#333')
            .text(d.name || '');

          // Selection indicator - square dotted line matching node size
          if (selected[d.id]) {
            selection.append('rect')
              .attr('x', -22) // Slightly larger than node
              .attr('y', -14)
              .attr('width', 44)
              .attr('height', 28)
              .attr('rx', 4) // Same rounded corners
              .attr('ry', 4)
              .attr('fill', 'none')
              .attr('stroke', 'red')
              .attr('stroke-width', 2)
              .attr('stroke-dasharray', '5,5'); // Dotted line pattern
          }
        } catch (e) {
          log('drawAndRunSimulation: node render error', e, 'error');
        }
      });

    // Add drag and click functionalities with fixed positioning
    const drag = d3.drag()
      .on('start', (event, d) => {
        try {
          // Don't restart simulation, just track dragging
          setIsDragging(true);
        } catch (e) { log('drawAndRunSimulation: drag start error', e, 'error'); }
      })
      .on('drag', (event, d) => {
        try {
          // Update fixed position during drag
          d.fx = event.x;
          d.fy = event.y;
          d.x = event.x;
          d.y = event.y;
          // Manually update the node position immediately
          d3.select(event.sourceEvent.target.parentNode)
            .attr('transform', `translate(${d.x}, ${d.y})`);
        } catch (e) { log('drawAndRunSimulation: drag error', e, 'error'); }
      })
      .on('end', (event, d) => {
        try {
          // Keep the node fixed at its new position
          d.fx = d.x;
          d.fy = d.y;
          setIsDragging(false);

          // Update the graphData to persist the new position
          const updatedNodes = graphData.nodes.map(node => {
            if (node.id === d.id) {
              return { ...node, x: d.x, y: d.y, fx: d.x, fy: d.y };
            }
            return node;
          });

          // Note: setGraphData will not trigger auto-save anymore
          setGraphData({
            nodes: updatedNodes,
            links: graphData.links
          });

          if (selected[d.id]) {
            setSelected({ ...selected, [d.id]: { ...d, x: d.x, y: d.y, fx: d.x, fy: d.y } });
          }

          log('Node drag completed - position updated without auto-save', {
            nodeId: d.id,
            position: { x: d.x, y: d.y }
          });
        } catch (e) { log('drawAndRunSimulation: drag end error', e, 'error'); }
      });

    node.call(drag);

    node.on('click', (event, d) => {
      try {
        if (!d) return;
        event.stopPropagation();
        log('Node click event triggered', { d, event });
        onNodeClickedEventHandler(d, event);
      } catch (e) {
        log('drawAndRunSimulation: node click error', e, 'error');
        // Don't let click errors break the UI
      }
    });

    node.on('dblclick', (event, d) => {
      try {
        if (!d) return;
        event.stopPropagation();
        onNodeDoubleClickEventHandler(d, event);
      } catch (e) { log('drawAndRunSimulation: node dblclick error', e, 'error'); }
    });

    node.on('contextmenu', (event, d) => {
      try {
        log('Context Menu', { event, d });
        event.preventDefault();
        return false;
      } catch (e) { log('drawAndRunSimulation: node contextmenu error', e, 'error'); }
    });

    simulation.on('tick', () => {
      try {
        // Always update positions since we're using fixed positioning
        if (link) {
          link.attr('x1', (d: any) => d.source.x || d.source.fx)
            .attr('y1', (d: any) => d.source.y || d.source.fy)
            .attr('x2', (d: any) => d.target.x || d.target.fx)
            .attr('y2', (d: any) => d.target.y || d.target.fy);
        }
        if (node) {
          node.attr('transform', (d: any) => `translate(${d.x || d.fx}, ${d.y || d.fy})`);
        }
      } catch (e) { log('drawAndRunSimulation: simulation tick error', e, 'error'); }
    });

    // Force an immediate position update since simulation is stopped
    if (link) {
      link.attr('x1', (d: any) => d.source.x || d.source.fx)
        .attr('y1', (d: any) => d.source.y || d.source.fy)
        .attr('x2', (d: any) => d.target.x || d.target.fx)
        .attr('y2', (d: any) => d.target.y || d.target.fy);
    }
    if (node) {
      node.attr('transform', (d: any) => `translate(${d.x || d.fx}, ${d.y || d.fy})`);
    }

    return () => simulation.stop();
  }

  useEffect(() => {
    try {
      // clear the svg
      const svg = d3.select(svgRef.current);
      svg.selectAll('*').remove();

      drawAndRunSimulation();
    } catch (error) {
      log('drawAndRunSimulation useEffect error', error, 'error');
      // Don't let rendering errors break the component
    }
  }, [graphData.nodes, graphData.links, keyPressed, selected, expanded, selectedLink]);

  const MenuProps = {
    PaperProps: {
      style: {
        maxHeight: ITEM_HEIGHT * 4.5 + ITEM_PADDING_TOP,
        width: 250,
      },
    },
  };
  // system selector drop down
  // renderValue={(selected) => (
  //   <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
  //     {selected.map((value) => (
  //       <Chip key={value} label={value} />
  //     ))}
  //   </Box>
  // )}`

  const onCanvasKeyUp: React.KeyboardEventHandler<SVGSVGElement> = (evt) => {
    log(`Canvas key up`, evt)
  }


  const selector = <>
    <FormControl sx={{ m: 1, width: 300 }}>
      <Select
        labelId="demo-multiple-name-label"
        id="demo-multiple-name"
        label="Select Systems"
        size='small'
        multiple
        value={selectedCatalogs || []}
        onChange={onSystemsChanged}
        renderValue={(selected) => (
          <Box sx={{ display: '-ms-flexbox', gap: 0.5, maxHeight: 150 }}>
            {Array.isArray(selected) && selected.map((value) => (
              <Chip key={value} label={value} />
            ))}
          </Box>
        )}
        input={<OutlinedInput label="Name" />}
        MenuProps={MenuProps}
      >
        {Array.isArray(catalogs) && catalogs.map((node) => (
          <MenuItem
            key={node.id}
            value={node.name}
          >
            {node.name}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  </>

  const LinkSelectedNodes = () => {
    log('LinkSelectedNodes', { graphData, selected });

    const nodes = Object.values(selected);
    if (nodes.length < 2) return;
    const links = nodes.map((node, index) => {
      if (index === 0) return null;
      return {
        source: nodes[0].id,
        target: node.id,
        value: 10,
        type: 'implicit',
      };
    }).filter((elem) => elem !== null);

    log('Links', { links });
    const newGraphData = {
      links: [
        ...graphData.links,
        ...links],
      nodes: [...graphData.nodes]
    };
    setGraphData(newGraphData);
  }

  const RemoveLinkSelectedNodes = () => {
    log('RemoveLinkSelectedNodes', { selected, graphData });
    const nodes = Object.values(selected);
    if (nodes.length < 2) return;
    const links = graphData.links.filter((link) => {
      if (link.source.id === nodes[0].id && link.target.id === nodes[1].id) return false;
      return true;
    });

    log('Links', { links });
    const newGraphData = {
      links: [
        ...links],
      nodes: [...graphData.nodes]
    };
    setGraphData(newGraphData);
  }

  const onCanvasClicked: React.MouseEventHandler<SVGSVGElement> = (evt) => {
    log('Canvas clicked', { evt, keyPressed, shiftKey: evt.shiftKey });

    // Only clear selections if not holding shift key (to allow multi-select)
    const isMultiSelect = keyPressed || evt.shiftKey;
    if (!isMultiSelect) {
      setSelected({});
    }

    // collapse all expanded menus
    let nextSelectedNodeProps = { ...selectedNodeProps };
    Object.keys(selectedNodeProps).forEach((key) => {
      nextSelectedNodeProps[key] = { expanded: false };
    });
    setSelectNodeProps(nextSelectedNodeProps);
  }

  // pagination component
  const pagination = (
    <Grid container>
      <Grid item xs={12} lg={12}>
        <Toolbar>
          {selector}
          <MaterialCore.TextField
            id="outlined-search"
            label="Search"
            type="search"
            size='small'
            value={searchText}
            onChange={(evt) => {
              setSearchText(evt.target.value);
            }}
          />

          <IconButton
            disabled={Object.keys(selected).length < 2}
            onClick={LinkSelectedNodes}
          >
            <MaterialIcons.Link />
          </IconButton>

          <IconButton
            disabled={Object.keys(selected).length < 2}
            onClick={RemoveLinkSelectedNodes}
          >
            <MaterialCore.Tooltip title="Remove Link">
              <MaterialIcons.LinkOff />
            </MaterialCore.Tooltip>
          </IconButton>

          <MaterialCore.Tooltip title="Provide a name for your perspective">
            <MaterialCore.TextField
              id="GraphModelName"
              label="Model Name"
              type="text"
              size='small'
              value={modelName}
              onChange={(evt) => {
                setModelName(evt.target.value);
              }}
            >
            </MaterialCore.TextField>
          </MaterialCore.Tooltip>

          <MaterialCore.Tooltip title="Save graph manually (auto-save disabled due to server issues)">
            <IconButton
              onClick={() => {
                log('Manual save triggered');
                saveGraph();
              }}
              disabled={saving}
              color="primary"
            >
              <MaterialIcons.Save />
            </IconButton>
          </MaterialCore.Tooltip>

          {saving && (
            <MaterialCore.CircularProgress size={20} />
          )}

        </Toolbar>
      </Grid>
    </Grid>
  )

  const indexNode = (node: ReactorNode) => { }

  const crawlNode = (node: ReactorNode, options: any) => { }

  const syncNode = (node: ReactorNode, options: any) => { }

  const loadDataForNode = async (node: ForceDirectedGraphNode, options?: any) => {
    log('loadDataForNode', { node, options });
    // is the node expanded already?
    if (expanded[node.id]) {
      log('Node already expanded', { node });
      // if the node is already expanded we do not need to load the data again
      // and we can collapse the node the use effect will re load the data.
      const nextExpanded = { ...expanded };
      delete nextExpanded[node.id];

      // remove the children related to this node
      // and remove the links that are children
      let nextLinks = graphData.links.filter((link) => {
        if (link.source.id === node.id && link.type === "child") return false;
        return true;
      });
      // collect all the children of the node using the link type
      const childrenLinks = graphData.links.filter((link) => link.source.id === node.id && link.type === 'child');
      // remove the children links from the graph
      const childNodes = graphData.nodes.filter((n) => { childrenLinks.find((link) => link.target.id === n.id) });
      // remove the children nodes from the graph
      const nextNodes = graphData.nodes.filter((n) => !childNodes.find((c) => c.id === n.id));
      // remove any links that were linked to the childNodes 
      nextLinks = nextLinks.filter((link) => !childNodes.find((c) => c.id === link.target.id));
      setExpanded(nextExpanded);
      setGraphData({ links: nextLinks, nodes: nextNodes });
      return;
    }

    let $node = await getData(node);
    log('Loaded Data', { $node });
    const $nodes = [];
    const $links = [];
    $node.children.forEach((child) => {
      $nodes.push({ ...child });
      $links.push({
        source: node.id,
        target: child.id,
        index: child.index,
        type: 'child',
        value: 1
      });
    });

    log('Loaded Links', { $links });
    setGraphData({ links: [...graphData.links, ...$links], nodes: [...graphData.nodes, ...$nodes] });
    setExpanded({ ...expanded, [node.id]: node });
  }

  const onMenuItemClicked = (evt: React.MouseEvent<HTMLLIElement, MouseEvent>, value: any, node: ReactorNode, attr: ReactorNodeAttribute) => {
    log('onMenuItemClicked', { evt, value, node });

    // if there is a form id we handle it here
    if (value.formId) {
      let _activeForm = {
        id: value.formId,
        props: value.formProps || { id: node.id },
        node: node,
        attr: attr,
        //@ts-ignore
        title: `${attr.value.title} - ${node.name}`
      };

      if (value.propsMap) {
        let nextProps = merge({ node }, value.propsMap) || {};
        _activeForm.props = { ..._activeForm.props, ...nextProps };
      }

      setActiveForm(_activeForm);
      unbindEventListeners();
    }

    // check if there is a handler function
    if (value.handler && typeof value.handler === 'function') {
      value.handler(node, value);
    }

    // check if there is a handler string
    if (value.handler && typeof value.handler === 'string') {
      const handler = reactory.getComponent(value.handler);
      if (typeof handler === 'function') {
        handler(node, value);
      } else if (typeof handler === 'object' && value.handlerMethod) {
        //@ts-ignore
        if (typeof handler[value.handlerMethod] === 'function') {
          //@ts-ignore
          handler[value.handlerMethod](node, value);
        }
      }
    }

    if (value.link) {
      window.open(value.link, '_blank');
    }
  }

  const onNodeButtonClicked = (node: ReactorNode, value: any) => {
    log('onNodeButtonClicked', { node, value });
    // check if there is a handler function
    if (value.handler && typeof value.handler === 'function') {
      value.handler(node, value);
    }

    // check if there is a handler string
    if (value.handler && typeof value.handler === 'string') {
      if (value.handler === "expand") {
        //load the data for the node 
      }

      const handler = reactory.getComponent(value.handler);
      if (typeof handler === 'function') {
        handler(node, value);
      } else if (typeof handler === 'object' && value.handlerMethod) {
        //@ts-ignore
        if (typeof handler[value.handlerMethod] === 'function') {
          //@ts-ignore
          handler[value.handlerMethod](node, value);
        }
      }
    }
  }

  // the stack of buttons for the selected nodes.
  const buttonStack = (<Fragment>
    {Object.keys(selected).map((key) => {
      const node = selected[key];
      const itemProps = selectedNodeProps[node.id] || { expanded: false };
      //const anchorEl = selectedNodeProps[node.id]?.anchorEl || null;

      let menus: React.ReactElement[] = [];
      let buttons: React.ReactElement[] = [];
      if (node.attributes) {

        node.attributes.forEach((attr: { key: string, value: any }) => {
          if (attr.key.startsWith('menu-') && attr.value) {
            menus.push((<MaterialCore.MenuItem key={attr.key}
              onClick={(evt) => { onMenuItemClicked(evt, attr.value, node, attr) }}>
              {attr.value.icon && <MaterialCore.Icon>{attr.value.icon}</MaterialCore.Icon>}
              {attr.value.title}
            </MaterialCore.MenuItem>));
          }

          if (attr.key.startsWith('button-') && attr.value) {
            buttons.push((<MaterialCore.IconButton key={attr.key}
              onClick={(evt) => {
                onNodeButtonClicked(node, attr.value);
              }}>
              {attr.value.title}
            </MaterialCore.IconButton>));
          }
        });

      }


      let menuButton = (<MaterialCore.IconButton
        key={`node_primary_drop_down_${node.id}`}
        color="primary"
        size="small"
        style={{ position: "absolute", top: node.y - 30, left: node.x + 30 }}
        onClick={(evt) => {
          log('Clicked', { node });
          let value = itemProps.expanded || false;
          setSelectNodeProps({ ...selectedNodeProps, [node.id]: { expanded: !value, anchorEl: !value === true ? evt.currentTarget : null } });
        }}>
        {itemProps.expanded === false ? <MaterialIcons.ExpandMore /> : <MaterialIcons.ExpandLess />}
      </MaterialCore.IconButton>);

      if (itemProps.expanded === true) {
        return <>{menuButton}<MaterialCore.Paper
          id={`menu-${node.id}`}
          style={{ padding: 5, position: "absolute", top: node.y - 20, left: node.x + 40 }}
        >
          {menus}
        </MaterialCore.Paper></>;
      }

      let loadChildrenButton = (<MaterialCore.IconButton
        key={`node_primary_expand_${node.id}`}
        color="primary"
        size="small"
        onClick={() => {
          log('Load Children', { node });
          loadDataForNode(node);
        }}
        style={{ position: "absolute", top: node.y - 45, left: node.x + 5 }}
      >
        {!expanded[node.id] && <MaterialIcons.PlusOne />}
        {expanded[node.id] && <MaterialIcons.Close />}
      </MaterialCore.IconButton>)

      buttons.push(loadChildrenButton);
      buttons.push(menuButton);

      //@ts-ignore
      return buttons;
    })}
  </Fragment>)

  let childForm = null;
  if (activeForm && activeForm.id) {
    const ActiveForm: any = reactory.getComponent(activeForm.id);
    reactory.log('Active Form', { ActiveForm });
    if (ActiveForm) {
      // @ts-ignore
      childForm = (
        <MaterialCore.Paper
          id={`active_form_${activeForm.id}`}>
          <ActiveForm {...{ ...activeForm.props, formData: activeForm.node, mode: 'edit' }} />
        </MaterialCore.Paper>
      )
    }
  }

  return (
    <>
      {error && (
        <MaterialCore.Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </MaterialCore.Alert>
      )}
      <Grid container key={'detail_view_grid'} >
        <Grid item xs={12} lg={12}>
          {Object.keys(selected).length > 0 && (
            <Typography variant="body2" sx={{ mb: 1 }}>
              Selected: {Object.keys(selected).length} node{Object.keys(selected).length !== 1 ? 's' : ''}
              {Object.keys(selected).length === 1 && ' (Click again to deselect)'}
              {Object.keys(selected).length > 1 && ' (Hold Shift + Click to add/remove nodes)'}
            </Typography>
          )}
          {Object.keys(selected).length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Click nodes to select • Hold Shift + Click for multi-select • Click empty space to clear selection
            </Typography>
          )}
        </Grid>
        <Grid>
          {pagination}
        </Grid>
        <Grid item xs={12} lg={12}>
          <div style={{ position: "relative" }} key={'canvas'}>
            <svg ref={svgRef}
              onKeyUp={onCanvasKeyUp}
              onClick={onCanvasClicked}></svg>
            {isDragging === false ? buttonStack : null}
          </div>
          {loading ? <Typography variant="body1" key="loading_text">Loading...</Typography> : null}
        </Grid>
      </Grid>
      <FullScreenModal
        key={'detail_view_modal'}
        open={!!(activeForm && activeForm.id)}
        onClose={() => {
          setActiveForm(null);
          bindEventListeners();
        }}
        title={activeForm?.title || ''}
      >
        {childForm}
      </FullScreenModal>
    </>
  )
}

const Definition = {
  nameSpace: 'reactor',
  name: 'ReactorGraphExplorerWidget',
  component: ReactorGraphExplorer,
  version: '1.0.0',
  roles: ['USER'],
  componentType: 'component'
}

//@ts-ignore
if (window && window.reactory) {
  //@ts-ignore
  (window.reactory.api as Reactory.Client.ReactorySDK).registerComponent(
    Definition.nameSpace,
    Definition.name,
    Definition.version,
    ReactorGraphExplorer,
    ['Graph Explorer'],
    Definition.roles,
    true,
    [],
    'widget');
  //@ts-ignore
  window.reactory.api.amq.raiseReactoryPluginEvent('loaded', { componentFqn: `${Definition.nameSpace}.${Definition.name}@${Definition.version}`, component: ReactorGraphExplorer });
}
