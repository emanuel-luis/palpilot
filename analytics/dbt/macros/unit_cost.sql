{% macro unit_cost(item) -%}
(select usd from {{ ref('unit_costs') }} where item = '{{ item }}')
{%- endmacro %}
