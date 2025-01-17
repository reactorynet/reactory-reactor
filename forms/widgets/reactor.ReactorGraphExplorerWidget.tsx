import { SelectChangeEvent } from '@mui/material/Select';
import Reactory, { React } from '@reactory/reactory-core';
import {
  ReactorNode, ReactorNodeAttribute,
} from '@reactory/server-modules/reactory-reactor/types/model.types';

import { Fragment } from 'react';

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
  }>(['react.React', 'material-ui.Material', 'd3.Package', 'core.FullScreenModal']);
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
  const { useState, useEffect, useRef } = React;
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
    setIsSaving(true);
    // save the graph data
    reactory.graphqlMutation(`mutation ReactorSaveSystemGraph($graph: ReactorySystemGraphInput!) { 
      ReactorSaveSystemGraph(graph: $graph) {
        success
        message
      }
    }`, { graph: graphData }).then((result) => { 
      
      if(result.errors && result.errors.length > 0) { 
        reactory.createNotification(`Error saving graph: ${result.errors.join(', ')}`, 'error')
      }

      if(result.data) { 
        log('Saved Graph', { result });
      }
    }).catch((err) => { 
      setError(err?.message || err?.toString() || 'Unknown Error');
    }).finally(() => { 
      setIsSaving(false);
    });
  }

  const setGraphData = (data: { nodes: ForceDirectedGraphNode[], links: ForceDirectedGraphLink[] }) => { 
    
    const nextNodes = uniqBy([...data.nodes], 'id');
    let nextLinks = [...data.links];

    log('Set Graph Data', { data, nextNodes})
      
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
      log('Loading catalogs', { options })
      const queryDef = graphql.queries['catalogsQuery'];
      const result = await query(queryDef.text, merge({ formData, formContext, props: queryDef.props || {} }, options.variables));
      if (result.errors && result.errors.length > 0) {
        setError(result.errors.join(', '));
      }
      if (result.data) {
        //@ts-ignore 
        const $data = merge(result.data[queryDef.name], queryDef.resultMap);
        log('Got Catalogs', { $data });
        setCatalogs($data);

        // check if the query object has a root property
        if (Object.keys(reactory.queryObject).indexOf('root') > -1) {
          const root = reactory.queryObject['root'];
          //TODO: Werner check why the query object value is not being
          // translated into selected items.
          log('Got Root', { root });
          if (root.indexOf(",")) {
            let keys = root.split(',');
            setSelectedCatalogs(keys);
          } else {
            setSelectedCatalogs([root]);
          }
        }
      }
    } catch (e) {
      setError(e?.message || e?.toString() || 'Unknown Error');

    }

    setLoading(false);
  }

  const getData = async (node: ReactorNode = {}): Promise<ReactorNode> => {    
    try {
      // we need to collect the roots that we want to search for
      log('Getting Data', { options, formData, formContext, props });
      const queryDef = graphql.queries["nodeChildrenQuery"];
      let inputItem = { formData, formContext, options, node, props: { ...queryDef?.props } || {}, parent }
      let variables = merge(inputItem, queryDef.variables);
      log('Query Variables', { variables, inputItem, queryDef }, 'info');
      const result = await query(queryDef.text, merge(inputItem, queryDef.variables));
      if (result.errors && result.errors.length > 0) {
        setError(result.errors.join(', '));
        log('Error', { error: result.errors.join(', ') }, 'error')
        return node
      }
      if (result.data) {
        //@ts-ignore
        log(`Results for node`, { node, result, queryDef });
        let $data = merge(result.data[queryDef.name], queryDef.resultMap) as ReactorNode;
        log('After conversion', { $data });
        if(typeof $data === 'object' && $data.id === node.id) { 
          return $data;
        }
        
        return node;
      }
      return node;
    } catch (err) {
      log('Some error', err)
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

  useEffect(()=>{
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
      if(node.name.toLowerCase().indexOf(searchText.toLowerCase()) > -1) {
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
          if(node.id in expanded) { 
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
    // when the graph data changes we want to 
    // save the graph data, so that we can restore it later
    // we also want to throttle the save operation
    saveGraph();
  }, [graphData.nodes, graphData.links, modelName]);


  const { width = 500, height = 500 } = options;
  let child = null;


  const onNodeClickedEventHandler = (node: ForceDirectedGraphNode, event: PointerEvent) => {
    log('onNodeClickedEventHandler', { node, event, selected, keyPressed });
    if (keyPressed) {
      if (selected[node.id]) {
        log('Removing from selection', { node });
        const newSelected = { ...selected };
        delete newSelected[node.id];
        setSelected(newSelected);
      } else {
        log('Adding to selection', { node });
        setSelected({ ...selected, [node.id]: node });
      }
    } else {
      log('Clearing selection and setting', { node });
      setSelected({ [node.id]: node });
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
    const nodes = [...graphData.nodes];
    const links = [...graphData.links];
    const width = reactory.getSizeSpec().innerWidth - 40;
    const height = 600;
    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height);

    svg.selectAll('*').remove();

    // Initialize force simulation
    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(200).strength(0.1))
      .force('charge', d3.forceManyBody())
      .force('center', d3.forceCenter(width / 2, height / 2));

    // Create link elements
    const link = svg.append('g')
      .attr('stroke', '#FFF')
      .attr('stroke-opacity', 0.6)
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('style', (d: ForceDirectedGraphLink) => {  
        if(d.source.id === selectedLink?.source.id && d.target.id === selectedLink?.target.id) { 
          return 'cursor: pointer; stroke: red; stroke-width: 2px;';
        }

        return 'cursor: pointer; stroke: #999; stroke-width: 2px;';
      })
      .attr('stroke-width', (d: ForceDirectedGraphLink) => Math.sqrt(d.value))
      .attr('stroke', (d: ForceDirectedGraphLink) => { 
        return d.source.id === selectedLink?.source.id && d.target.id === selectedLink?.target.id ? 'red' : '#999';
      });

    link.distance = (d: ForceDirectedGraphLink) => d.distance || 200;
    link.strength = (d: ForceDirectedGraphLink) => d.strength || 0.1;

    // add a click event handler for the link
    link.on('click', (event: any, d: ForceDirectedGraphLink) => {
      log('Link Clicked', { event, d });
      event.stopPropagation();
      // flag the link as selected
      if(selectedLink && selectedLink.source.id === d.source.id && selectedLink.target.id === d.target.id) { 
        setSelectedLink(null);
        return;
      }

      setSelectedLink(d);
    });


    // Create node elements with conditional rendering based on node type
    const node = svg.append('g')
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .selectAll('g')
      .data(nodes)
      .join('g') // Use a 'g' element to group each node's SVG
      .each(function (d: ForceDirectedGraphNode) { // Use 'each' to process each node individually
        const selection = d3.select(this); // 'this' refers to the current 'g' element
        const icon = d.attributes.find(attr => attr.key === "icon")?.value;

        if(icon && icon.type === "svg" && icon.svg) {
          // wrap the svg in a div element and offset it to center
          selection.append('g')
            .attr('transform', 'translate(-16, -16)')
            .html(icon.svg);

        } else if (icon && icon.type === "icon"){ 
          //if icon.type is "icon" then
          // we use a material icon to render the icon
          selection.html(`<span class="material-symbols-outlined">
          ${icon.icon}}
          </span>`)
        } else {
          selection.append('circle')
            .attr('r', 16)
            .attr('fill', 'blue')
            .attr('stroke', 'white');
        }
        
        // add label element
        selection.append('text')
          .attr('x', -1 * (d.name.length) * 2)
          .attr('y', 45)
          .attr('dy', '0.30em')
          .text(d.name);

        // if node is selected add a dashed border
        if (selected[d.id]) {
          selection.append('circle')
            .attr('r', 25)
            .attr('fill', 'none')
            .attr('stroke', 'red')
            .attr('cx', 0)
            .attr('cy', 0)
            .attr('stroke-dasharray', '5,2,2,5');
          // mount a react button on the svg
        }
      });

    // Add drag and click functionalities as before
    const drag = d3.drag()
      .on('start', (event: any, d: ForceDirectedGraphNode) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;

        setIsDragging(true);
      })
      .on('drag', (event: any, d: ForceDirectedGraphNode) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event: any, d: ForceDirectedGraphNode) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
        setIsDragging(false);
        if (selected[d.id]) {
          setSelected({ ...selected, [d.id]: d });
        }
      });

    node.call(drag);

    node.on('click', (event: any, d: ForceDirectedGraphNode) => {
      console.log('Node Clicked', { event, d });
      event.stopPropagation();
      onNodeClickedEventHandler(d, event);
    });

    // add double click event handler
    node.on('dblclick', (event: any, d: ForceDirectedGraphNode) => {
      console.log('Node Double Clicked', { event, d });
      event.stopPropagation();
      // if the node is a catalog node, we want to load the data for the node
      onNodeDoubleClickEventHandler(d, event);      
    });

    node.on('contextmenu', (event: any, d: ForceDirectedGraphNode) => { 
      log('Context Menu', { event, d });
      event.preventDefault();
      return false;
    });

    // Update positions on each tick
    simulation.on('tick', () => {
      link.attr('x1', (d: ForceDirectedGraphNode) => d.source.x)
        .attr('y1', (d: ForceDirectedGraphNode) => d.source.y)
        .attr('x2', (d: ForceDirectedGraphNode) => d.target.x)
        .attr('y2', (d: ForceDirectedGraphNode) => d.target.y);

      // Update node position by translating the 'g' element
      node.attr('transform', (d: ForceDirectedGraphNode) => `translate(${d.x}, ${d.y})`);
    });


    // Clean up
    return () => simulation.stop();
  }

  useEffect(() => {
    // clear the svg
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    drawAndRunSimulation();
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
        value={selectedCatalogs}
        onChange={onSystemsChanged}
        renderValue={(selected) => (
          <Box sx={{ display: '-ms-flexbox', gap: 0.5, maxHeight: 150 }}>
            {selected.map((value) => (
              <Chip key={value} label={value} />
            ))}
          </Box>
        )}
        input={<OutlinedInput label="Name" />}
        MenuProps={MenuProps}
      >
        {catalogs?.map((node) => (
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
      if(link.source.id === nodes[0].id && link.target.id === nodes[1].id) return false;
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
    log('Canvas clicked', { evt });
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
            onChange={(evt)=>{
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
                onChange={(evt)=>{
                  setModelName(evt.target.value);
                }}
              >
          </MaterialCore.TextField>
          </MaterialCore.Tooltip>
          
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
        if(link.source.id === node.id && link.type === "child") return false;
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
    if(value.formId) { 
      let _activeForm = { 
        id: value.formId,
        props: value.formProps || { id: node.id },
        node: node,
        attr: attr,
        //@ts-ignore
        title: `${attr.value.title} - ${node.name}`
      };

      if(value.propsMap) {
        let nextProps = merge({ node }, value.propsMap) || {};
        _activeForm.props = { ..._activeForm.props, ...nextProps };
      }

      setActiveForm(_activeForm);    
      unbindEventListeners();
    }

    // check if there is a handler function
    if(value.handler && typeof value.handler === 'function') {
      value.handler(node, value);
    }

    // check if there is a handler string
    if(value.handler && typeof value.handler === 'string') { 
      const handler = reactory.getComponent(value.handler);
      if(typeof handler === 'function') {
        handler(node, value);
      } else if (typeof handler === 'object' && value.handlerMethod) {
        //@ts-ignore
        if(typeof handler[value.handlerMethod] === 'function') { 
          //@ts-ignore
          handler[value.handlerMethod](node, value);
        }
      }
    }

    if(value.link) {
      window.open(value.link, '_blank');
    }
  }

  const onNodeButtonClicked = (node: ReactorNode, value: any) => { 
    log('onNodeButtonClicked', { node, value });
    // check if there is a handler function
    if(value.handler && typeof value.handler === 'function') {
      value.handler(node, value);
    }

    // check if there is a handler string
    if(value.handler && typeof value.handler === 'string') { 
      if(value.handler === "expand") {
        //load the data for the node 
      }

      const handler = reactory.getComponent(value.handler);
      if(typeof handler === 'function') {
        handler(node, value);
      } else if (typeof handler === 'object' && value.handlerMethod) {
        //@ts-ignore
        if(typeof handler[value.handlerMethod] === 'function') { 
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

        node.attributes.forEach((attr: {key: string, value: any}) => {
          if (attr.key.startsWith('menu-') && attr.value) {
            menus.push((<MaterialCore.MenuItem key={attr.key}
              onClick={(evt) => { onMenuItemClicked(evt, attr.value, node, attr) }}>
              {attr.value.icon && <MaterialCore.Icon>{attr.value.icon}</MaterialCore.Icon>}
              {attr.value.title}
            </MaterialCore.MenuItem>));
          }
          
          if(attr.key.startsWith('button-') && attr.value) { 
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
  if(activeForm && activeForm.id) {
    const ActiveForm: any = reactory.getComponent(activeForm.id);
    reactory.log('Active Form', { ActiveForm });
    if(ActiveForm) { 
      // @ts-ignore
      childForm = (
        <MaterialCore.Paper
          id={`active_form_${activeForm.id}`}>
          <ActiveForm { ...{...activeForm.props, formData: activeForm.node, mode: 'edit' } } />
        </MaterialCore.Paper>
      )
    }
  }

  return (
    <>
      <Grid container key={'detail_view_grid'} >
        <Grid item xs={12} lg={12}>
          {Object.keys(selected).length > 0 && <Typography variant="body2">Selected: {Object.keys(selected).length} nodes</Typography>}
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
        open={activeForm && activeForm.id}
        onClose={() => { 
          setActiveForm(null); 
          bindEventListeners(); }}
        title={activeForm?.title || ''}>
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
